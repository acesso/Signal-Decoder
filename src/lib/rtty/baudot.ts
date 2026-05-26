// ITA2 Baudot character tables, indexed by 5-bit code (0–31)
// LSB is transmitted first; bit 0 = least significant

export const LTRS_TABLE: string[] = [
  '\0', 'E', '\n', 'A', ' ', 'S', 'I', 'U',
  '\r', 'D', 'R',  'J', 'N', 'F', 'C', 'K',
  'T',  'Z', 'L',  'W', 'H', 'Y', 'P', 'Q',
  'O',  'B', 'G',  '\x1b', 'M', 'X', 'V', '\x1f',
];

export const FIGS_TABLE: string[] = [
  '\0', '3', '\n', '-', ' ', "'", '8', '7',
  '\r', '\x05', '4', '\x07', ',', '!', ':', '(',
  '5',  '"',  ')', '2', '#', '6', '0', '1',
  '9',  '?',  '&', '\x1b', '.', '/', '=', '\x1f',
];

export const LTRS_SHIFT_CODE = 31; // 0x1F — switch to letters mode
export const FIGS_SHIFT_CODE = 27; // 0x1B — switch to figures mode
