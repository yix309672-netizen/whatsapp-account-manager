import { COUNTRY_CODES } from '../data/countryCodes';

// 区号纯数字（如 "+1 340" -> "1"，"+66" -> "66"）
const CC_DIGITS = COUNTRY_CODES.map((c) => {
  const code = c.code.replace(/[^0-9]/g, '');
  return code.startsWith('1') && c.code.includes(' ') ? '1' : code;
});

// 按长度降序，优先匹配更长区号（如 +886 优先于 +86）
const SORTED_CC = Array.from(new Set(CC_DIGITS)).sort((a, b) => b.length - a.length);

// 将纯数字号码格式化为 "+区号 号码"；无法识别区号时原样返回
export function formatPhone(input: string): string {
  const digits = String(input || '').replace(/[^0-9]/g, '');
  if (!digits) return '—';
  for (const cc of SORTED_CC) {
    if (digits.startsWith(cc)) {
      const rest = digits.slice(cc.length);
      if (rest) return `+${cc} ${rest}`;
      break;
    }
  }
  return digits;
}