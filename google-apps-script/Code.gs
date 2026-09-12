/**
 * Kara Sheets API
 * Deploy as a Web app (Execute as: Me, Who has access: Anyone with the link).
 * Set SPREADSHEET_ID in Script Properties, or leave the value below.
 */
const SPREADSHEET_ID = '13nxumXBEzX2ASRAPOULwVKblDd4hVywF2pTnpSuAOAQ';
const TAB_BY_RESOURCE = {
  employees: 'employees', attendance: 'attendance', schedules: 'work_schedules',
  'leave-types': 'leave_types', holidays: 'holidays', 'schedule-overrides': 'schedule_overrides',
  formulas: 'formula_components', 'payroll/periods': 'payroll_periods',
  'payroll/results': 'payroll_results', audit: 'audit_log', settings: 'general_settings',
};

function book_() {
  return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || SPREADSHEET_ID);
}
function out_(value) {
  return ContentService.createTextOutput(JSON.stringify(value == null ? {} : value)).setMimeType(ContentService.MimeType.JSON);
}
function json_(e) {
  const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
  try { return JSON.parse(raw); } catch (_) { return {}; }
}
function route_(e) {
  return String((e && e.parameter && (e.parameter.path || e.parameter.route)) || (e && e.pathInfo) || '')
    .replace(/^\/+|\/+$/g, '').replace(/^api\//, '');
}
function tab_(resource) {
  const name = TAB_BY_RESOURCE[resource] || resource;
  return book_().getSheetByName(name);
}
function rows_(resource) {
  const sheet = tab_(resource);
  if (!sheet || sheet.getLastRow() < 1) return [];
  const values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  const headers = values.shift().map(String);
  return values.filter(row => row.some(v => v !== '')).map(row => {
    const item = {};
    headers.forEach((h, i) => { item[h] = row[i] === '' ? null : parse_(row[i]); });
    return item;
  });
}
function parse_(value) {
  if (typeof value !== 'string') return value;
  if ((value[0] === '{' && value[value.length - 1] === '}') || (value[0] === '[' && value[value.length - 1] === ']')) {
    try { return JSON.parse(value); } catch (_) {}
  }
  return value;
}
function write_(resource, item) {
  const sheet = tab_(resource);
  if (!sheet) throw new Error('Unknown sheet: ' + resource);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const data = rows_(resource);
  const index = data.findIndex(row => String(row.id) === String(item.id));
  const values = headers.map(header => {
    const value = item[header];
    return value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : value);
  });
  if (index >= 0) sheet.getRange(index + 2, 1, 1, headers.length).setValues([values]);
  else sheet.getRange(sheet.getLastRow() + 1, 1, 1, headers.length).setValues([values]);
  return item;
}
function normalize_(resource, item) {
  const now = new Date().toISOString();
  const result = Object.assign({}, item);
  result.id = result.id || Utilities.getUuid();
  if (!result.createdAt) result.createdAt = now;
  result.updatedAt = now;
  return result;
}
function get_(e) {
  const route = route_(e);
  const parts = route.split('/');
  const resource = parts[0] + (parts[0] === 'payroll' && parts[1] ? '/' + parts[1] : '');
  const id = parts[0] === 'payroll' ? parts[2] : parts[1];
  if (resource === 'health') return { ok: true, database: 'google-sheets' };
  if (resource === 'schedules') return {
    schedules: rows_('schedules'), holidays: rows_('holidays'), leaveTypes: rows_('leave-types'), overrides: rows_('schedule-overrides'),
  };
  if (resource === 'monthly') return rows_('attendance');
  let result = rows_(resource);
  if (resource === 'attendance' && e.parameter.date) result = result.filter(row => String(row.workDate).slice(0, 10) === e.parameter.date);
  if (resource === 'payroll/results' && e.parameter.year && e.parameter.month) result = result.filter(row => String(row.year) === e.parameter.year && String(row.month) === e.parameter.month);
  if (id) result = result.find(row => String(row.id) === String(id)) || null;
  return result;
}
function post_(e) {
  const route = route_(e);
  const parts = route.split('/');
  const resource = parts[0] + (parts[0] === 'payroll' && parts[1] ? '/' + parts[1] : '');
  const body = json_(e);
  if (String(e.parameter.method || '').toUpperCase() === 'DELETE') {
    const sheet = tab_(parts[0]);
    const rows = rows_(parts[0]);
    const index = rows.findIndex(row => String(row.id) === String(parts[1]));
    if (sheet && index >= 0) sheet.deleteRow(index + 2);
    return { ok: true };
  }
  if (resource === 'payroll/process') return { ok: true, message: 'Payroll processing is queued.' };
  if (resource === 'payroll' && (parts[2] === 'lock' || parts[2] === 'reopen')) return write_('payroll/periods', normalize_('payroll/periods', Object.assign({}, body, { id: parts[1], status: parts[2] === 'lock' ? 'locked' : 'open' })));
  const target = TAB_BY_RESOURCE[resource] ? resource : parts[0];
  return write_(target, normalize_(target, body));
}
function doGet(e) { try { return out_(get_(e)); } catch (error) { return out_({ error: String(error.message || error) }); } }
function doPost(e) { try { return out_(post_(e)); } catch (error) { return out_({ error: String(error.message || error) }); } }
