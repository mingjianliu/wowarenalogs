import moment from 'moment-timezone';
import { map } from 'rxjs/operators';

import { parseWowToJSON } from '../../jsonparse';
import { logDebug, logInfo } from '../../logger';
import { ILogLine, LogEvent } from '../../types';

let nextId = 0;

function isDigitString(str: string): boolean {
  const len = str.length;
  if (len === 0) return false;
  for (let i = 0; i < len; i++) {
    const charCode = str.charCodeAt(i);
    if (charCode < 48 || charCode > 57) return false;
  }
  return true;
}

function isValidOffsetString(str: string): boolean {
  const len = str.length;
  if (len === 0 || len > 3) return false;
  let start = 0;
  if (str[0] === '+' || str[0] === '-') {
    start = 1;
  }
  if (len <= start) return false;
  for (let i = start; i < len; i++) {
    const charCode = str.charCodeAt(i);
    if (charCode < 48 || charCode > 57) return false;
  }
  return true;
}

function parseCombatLogTimestamp(timestamp: string, timezone: string): number | null {
  const firstSlash = timestamp.indexOf('/');
  if (firstSlash === -1) return null;

  const secondSlash = timestamp.indexOf('/', firstSlash + 1);
  if (secondSlash === -1) return null;

  const space = timestamp.indexOf(' ', secondSlash + 1);
  if (space === -1) return null;

  const firstColon = timestamp.indexOf(':', space + 1);
  if (firstColon === -1) return null;

  const secondColon = timestamp.indexOf(':', firstColon + 1);
  if (secondColon === -1) return null;

  const dot = timestamp.indexOf('.', secondColon + 1);
  if (dot === -1) return null;

  const monthStr = timestamp.slice(0, firstSlash);
  const dayStr = timestamp.slice(firstSlash + 1, secondSlash);
  const yearStr = timestamp.slice(secondSlash + 1, space);
  const hourStr = timestamp.slice(space + 1, firstColon);
  const minuteStr = timestamp.slice(firstColon + 1, secondColon);
  const secondStr = timestamp.slice(secondColon + 1, dot);

  if (timestamp.length < dot + 4) return null;
  const millisStr = timestamp.slice(dot + 1, dot + 4);

  if (
    monthStr.length < 1 ||
    monthStr.length > 2 ||
    dayStr.length < 1 ||
    dayStr.length > 2 ||
    yearStr.length !== 4 ||
    hourStr.length < 1 ||
    hourStr.length > 2 ||
    minuteStr.length !== 2 ||
    secondStr.length !== 2 ||
    millisStr.length !== 3
  ) {
    return null;
  }

  if (
    !isDigitString(monthStr) ||
    !isDigitString(dayStr) ||
    !isDigitString(yearStr) ||
    !isDigitString(hourStr) ||
    !isDigitString(minuteStr) ||
    !isDigitString(secondStr) ||
    !isDigitString(millisStr)
  ) {
    return null;
  }

  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  const year = parseInt(yearStr, 10);
  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);
  const second = parseInt(secondStr, 10);
  const millisecond = parseInt(millisStr, 10);

  const offsetString = timestamp.slice(dot + 4);

  if (offsetString.length > 0) {
    if (!isValidOffsetString(offsetString)) {
      return null;
    }
    const offsetHours = parseInt(offsetString, 10);
    return Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offsetHours * 60 * 60 * 1000;
  }

  const parsedMoment = moment.tz(
    {
      year,
      month: month - 1,
      date: day,
      hour,
      minute,
      second,
      millisecond,
    },
    timezone,
  );

  return parsedMoment.isValid() ? parsedMoment.valueOf() : null;
}

export const stringToLogLine = (timezone: string) => {
  // Reset the module-level line-id counter for each new pipeline instance so log-line ids are
  // deterministic per parse (start at 0), rather than depending on how many lines were parsed by
  // prior parsers in the same process. Ids are only used for within-match uniqueness, so a per-parse
  // reset is safe; this closes the same module-level-state class as the shuffle-buffer fix.
  nextId = 0;
  return map((line: string): ILogLine | string => {
    const separatorIndex = line.indexOf('  ');
    if (separatorIndex === -1) {
      logDebug(`INVALID LINE: ${line}`);
      return line;
    }

    const tsString = line.slice(0, separatorIndex);
    const rest = line.slice(separatorIndex + 2);
    const commaIndex = rest.indexOf(',');
    if (commaIndex === -1) {
      logDebug(`INVALID LINE: ${line}`);
      return line;
    }

    const eventName = rest.slice(0, commaIndex);

    // unsupported event
    if (!(eventName in LogEvent)) {
      logDebug(`UNSUPPORTED EVENT: ${eventName}`);
      return line;
    }

    const event = LogEvent[eventName as keyof typeof LogEvent];
    const jsonPayload = rest.slice(commaIndex + 1).trimEnd();
    const jsonParameters = parseWowToJSON(jsonPayload);
    const timestamp = parseCombatLogTimestamp(tsString, timezone);

    if (timestamp === null || isNaN(timestamp)) {
      logInfo('INVALID TIMESTAMP', tsString);
      return line;
    }

    return {
      id: (nextId++).toFixed(),
      timestamp,
      event,
      parameters: jsonParameters.data,
      raw: line,
      timezone,
    };
  });
};
