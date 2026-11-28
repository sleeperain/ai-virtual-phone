import { kvGet, kvSet, registerKvMigration } from "./kv-db";

/* ══════════════════════════════════════════
   锁屏密码

   刻意不放进 ThemeProfile：
   1) 主题包会导出 ThemeProfile，密码跟着走就等于把密码送人；
   2) 「恢复默认外观」会重置 ThemeProfile，密码不该被顺手清掉。

   ⚠️ 定位说明：这是浏览器本地应用，数据都在本机 IndexedDB 里。
   密码只能挡住"拿到这台手机、照着界面点两下"的人；
   挡不住打开开发者工具翻本地存储的人。它是隐私遮挡 + 沉浸感，不是加密。
   ══════════════════════════════════════════ */

const PASSCODE_KEY = "ai_phone_lock_passcode_v1";
registerKvMigration(PASSCODE_KEY);

/** 密码位数 */
export const PASSCODE_LENGTH = 4;
/** 忘记密码后重置成的默认密码 */
export const DEFAULT_PASSCODE = "0000";

export type LockPasscodeState = {
  enabled: boolean;
  code: string;
};

const DISABLED: LockPasscodeState = { enabled: false, code: DEFAULT_PASSCODE };

function normalizeCode(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_PASSCODE;
  const digits = raw.replace(/\D/g, "").slice(0, PASSCODE_LENGTH);
  return digits.length === PASSCODE_LENGTH ? digits : DEFAULT_PASSCODE;
}

export function readLockPasscode(): LockPasscodeState {
  try {
    const raw = kvGet(PASSCODE_KEY);
    if (!raw) return { ...DISABLED };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { ...DISABLED };
    const source = parsed as Record<string, unknown>;
    return {
      enabled: source.enabled === true,
      code: normalizeCode(source.code),
    };
  } catch {
    return { ...DISABLED };
  }
}

export function writeLockPasscode(state: LockPasscodeState): LockPasscodeState {
  const normalized: LockPasscodeState = {
    enabled: Boolean(state.enabled),
    code: normalizeCode(state.code),
  };
  kvSet(PASSCODE_KEY, JSON.stringify(normalized));
  return normalized;
}

/** 忘记密码：把密码重置成 0000，开关状态保持不变 */
export function resetLockPasscode(): LockPasscodeState {
  const current = readLockPasscode();
  return writeLockPasscode({ enabled: current.enabled, code: DEFAULT_PASSCODE });
}

/** 校验输入，长度不足一律不通过 */
export function verifyPasscode(input: string): boolean {
  const { enabled, code } = readLockPasscode();
  if (!enabled) return true;
  return input === code;
}
