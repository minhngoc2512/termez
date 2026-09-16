export interface GenOpts {
  length: number;
  upper: boolean;
  lower: boolean;
  digits: boolean;
  symbols: boolean;
}

const SETS = {
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ", // bỏ I, O gây nhầm
  lower: "abcdefghijkmnpqrstuvwxyz", // bỏ l
  digits: "23456789", // bỏ 0, 1
  symbols: "!@#$%^&*-_=+?",
};

export function generatePassword(o: GenOpts): string {
  let pool = "";
  if (o.upper) pool += SETS.upper;
  if (o.lower) pool += SETS.lower;
  if (o.digits) pool += SETS.digits;
  if (o.symbols) pool += SETS.symbols;
  if (!pool) pool = SETS.lower + SETS.digits;
  const len = Math.max(4, o.length);
  const rnd = new Uint32Array(len);
  crypto.getRandomValues(rnd);
  let out = "";
  for (let i = 0; i < len; i++) out += pool[rnd[i] % pool.length];
  return out;
}

/** Ước lượng độ mạnh 0..4 (heuristic length + variety). */
export function strength(pw: string): { score: number; label: string } {
  if (!pw) return { score: 0, label: "—" };
  let variety = 0;
  if (/[a-z]/.test(pw)) variety++;
  if (/[A-Z]/.test(pw)) variety++;
  if (/[0-9]/.test(pw)) variety++;
  if (/[^a-zA-Z0-9]/.test(pw)) variety++;
  const len = pw.length;
  let score = 0;
  if (len >= 8) score++;
  if (len >= 12 && variety >= 2) score++;
  if (len >= 14 && variety >= 3) score++;
  if (len >= 16 && variety >= 4) score++;
  score = Math.min(4, score);
  return { score, label: ["Very weak", "Weak", "Fair", "Good", "Strong"][score] };
}

/**
 * Copy vào clipboard rồi tự xóa sau `ms` (mặc định 10s, giống KeePassXC).
 * Chỉ xóa nếu clipboard vẫn đang giữ đúng giá trị này — tránh xóa nhầm thứ
 * người dùng copy sau đó.
 */
export function copyClearing(text: string, ms = 10000) {
  navigator.clipboard.writeText(text).catch(() => {});
  window.setTimeout(async () => {
    try {
      const cur = await navigator.clipboard.readText();
      if (cur !== text) return; // người dùng đã copy thứ khác → để yên
    } catch {
      /* không đọc được clipboard → cứ xóa cho an toàn */
    }
    navigator.clipboard.writeText("").catch(() => {});
  }, ms);
}
