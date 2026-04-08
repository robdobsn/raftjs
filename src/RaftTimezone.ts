/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftTimezone
// Part of RaftJS — IANA timezone to POSIX TZ string conversion for ESP-IDF
//
// Rob Dobson 2026
// (C) 2026 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Mapping of common IANA timezone names to POSIX TZ strings (with DST rules where applicable)
const IANA_TO_POSIX: Record<string, string> = {
  // UTC / GMT
  'UTC': 'UTC0',
  'Etc/UTC': 'UTC0',
  'Etc/GMT': 'GMT0',

  // Europe
  'Europe/London': 'GMT0BST,M3.5.0/1,M10.5.0',
  'Europe/Dublin': 'IST-1GMT0,M10.5.0,M3.5.0/1',
  'Europe/Paris': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Europe/Berlin': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Europe/Brussels': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Europe/Amsterdam': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Europe/Rome': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Europe/Madrid': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Europe/Zurich': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Europe/Vienna': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Europe/Stockholm': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Europe/Oslo': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Europe/Copenhagen': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Europe/Helsinki': 'EET-2EEST,M3.5.0/3,M10.5.0/4',
  'Europe/Athens': 'EET-2EEST,M3.5.0/3,M10.5.0/4',
  'Europe/Bucharest': 'EET-2EEST,M3.5.0/3,M10.5.0/4',
  'Europe/Warsaw': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Europe/Prague': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Europe/Lisbon': 'WET0WEST,M3.5.0/1,M10.5.0',
  'Europe/Moscow': 'MSK-3',
  'Europe/Istanbul': '<+03>-3',
  'Europe/Kiev': 'EET-2EEST,M3.5.0/3,M10.5.0/4',
  'Europe/Kyiv': 'EET-2EEST,M3.5.0/3,M10.5.0/4',

  // Americas
  'America/New_York': 'EST5EDT,M3.2.0,M11.1.0',
  'America/Chicago': 'CST6CDT,M3.2.0,M11.1.0',
  'America/Denver': 'MST7MDT,M3.2.0,M11.1.0',
  'America/Los_Angeles': 'PST8PDT,M3.2.0,M11.1.0',
  'America/Phoenix': 'MST7',
  'America/Anchorage': 'AKST9AKDT,M3.2.0,M11.1.0',
  'Pacific/Honolulu': 'HST10',
  'America/Toronto': 'EST5EDT,M3.2.0,M11.1.0',
  'America/Vancouver': 'PST8PDT,M3.2.0,M11.1.0',
  'America/Edmonton': 'MST7MDT,M3.2.0,M11.1.0',
  'America/Winnipeg': 'CST6CDT,M3.2.0,M11.1.0',
  'America/Halifax': 'AST4ADT,M3.2.0,M11.1.0',
  'America/St_Johns': 'NST3:30NDT,M3.2.0,M11.1.0',
  'America/Mexico_City': 'CST6',
  'America/Sao_Paulo': '<-03>3',
  'America/Argentina/Buenos_Aires': '<-03>3',
  'America/Santiago': '<-04>4<-03>,M9.1.6/24,M4.1.6/24',
  'America/Bogota': '<-05>5',
  'America/Lima': '<-05>5',

  // Asia
  'Asia/Tokyo': 'JST-9',
  'Asia/Shanghai': 'CST-8',
  'Asia/Hong_Kong': 'HKT-8',
  'Asia/Taipei': 'CST-8',
  'Asia/Singapore': '<+08>-8',
  'Asia/Seoul': 'KST-9',
  'Asia/Kolkata': 'IST-5:30',
  'Asia/Calcutta': 'IST-5:30',
  'Asia/Dubai': '<+04>-4',
  'Asia/Riyadh': '<+03>-3',
  'Asia/Tehran': '<+0330>-3:30',
  'Asia/Karachi': 'PKT-5',
  'Asia/Dhaka': '<+06>-6',
  'Asia/Bangkok': '<+07>-7',
  'Asia/Jakarta': 'WIB-7',
  'Asia/Ho_Chi_Minh': '<+07>-7',
  'Asia/Kuala_Lumpur': '<+08>-8',
  'Asia/Manila': 'PST-8',
  'Asia/Vladivostok': '<+10>-10',
  'Asia/Novosibirsk': '<+07>-7',
  'Asia/Yekaterinburg': '<+05>-5',

  // Oceania
  'Australia/Sydney': 'AEST-10AEDT,M10.1.0,M4.1.0/3',
  'Australia/Melbourne': 'AEST-10AEDT,M10.1.0,M4.1.0/3',
  'Australia/Brisbane': 'AEST-10',
  'Australia/Perth': 'AWST-8',
  'Australia/Adelaide': 'ACST-9:30ACDT,M10.1.0,M4.1.0/3',
  'Australia/Darwin': 'ACST-9:30',
  'Australia/Hobart': 'AEST-10AEDT,M10.1.0,M4.1.0/3',
  'Pacific/Auckland': 'NZST-12NZDT,M9.5.0,M4.1.0/3',
  'Pacific/Fiji': '<+12>-12',

  // Africa
  'Africa/Cairo': 'EET-2',
  'Africa/Johannesburg': 'SAST-2',
  'Africa/Lagos': 'WAT-1',
  'Africa/Nairobi': 'EAT-3',
  'Africa/Casablanca': '<+01>-1',
};

/**
 * Get the host machine's IANA timezone name.
 * Returns undefined if not available.
 */
export function getHostTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * Convert an IANA timezone name to a POSIX TZ string suitable for ESP-IDF.
 * Falls back to a simple UTC offset string if the IANA name is not in the lookup table.
 * Returns undefined if timezone cannot be determined.
 */
export function ianaToPosixTZ(iana: string): string | undefined {
  // Direct lookup
  const posix = IANA_TO_POSIX[iana];
  if (posix) return posix;

  // Fallback: compute simple UTC offset from current Date (no DST transitions)
  try {
    const offsetMin = new Date().getTimezoneOffset(); // minutes west of UTC (e.g. -60 for UTC+1)
    if (offsetMin === 0) return 'UTC0';
    // POSIX TZ convention: positive = west of UTC (opposite of ISO 8601)
    const hours = Math.trunc(offsetMin / 60);
    const mins = Math.abs(offsetMin % 60);
    let tz = `UTC${hours >= 0 ? '+' : '-'}${Math.abs(hours)}`;
    if (mins > 0) tz += `:${mins.toString().padStart(2, '0')}`;
    return tz;
  } catch {
    return undefined;
  }
}

/**
 * Get the host machine's timezone as a POSIX TZ string.
 * Attempts IANA lookup first, then falls back to UTC offset.
 */
export function getHostPosixTZ(): string | undefined {
  const iana = getHostTimezone();
  if (!iana) return undefined;
  return ianaToPosixTZ(iana);
}
