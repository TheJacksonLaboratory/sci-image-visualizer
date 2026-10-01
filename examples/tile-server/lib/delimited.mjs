/**
 * CSV / TSV parsing for the small tables users import (cell groupings). RFC 4180: quoted
 * fields may hold the delimiter, newlines and doubled quotes. The delimiter is a tab when the
 * header has tabs and no commas, else a comma.
 */

/** Rows of fields; blank lines are skipped and unquoted fields trimmed. */
export function parseDelimited(text) {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delim = firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;   // inside a quoted field
  let wasQuoted = false; // the current field was quoted (so keep its spaces)
  const endField = () => {
    row.push(wasQuoted ? field : field.trim());
    field = '';
    wasQuoted = false;
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field.trim() === '') {
      quoted = true;
      wasQuoted = true;
      field = '';
    } else if (ch === delim) {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else {
      field += ch;
    }
  }
  if (quoted) throw new RangeError('the table has an unterminated quoted field');
  if (field !== '' || wasQuoted || row.length) endRow();
  return rows;
}
