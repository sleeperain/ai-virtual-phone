"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  DEFAULT_PASSCODE,
  PASSCODE_LENGTH,
  resetLockPasscode,
  verifyPasscode,
} from "@/lib/lock-passcode";

/* ══════════════════════════════════════════
   锁屏密码盘（参考 iOS）

   排版按需求定：不显示时间，圆点上方一行「输入密码」；
   数字键盘下方是「忘记密码」胶囊，点了把密码重置成 0000。

   输对 → onUnlocked()，由锁屏接着走解锁流程；
   输错 → 圆点整行左右摇一下，清空重来。
   ══════════════════════════════════════════ */

/** 输错时摇晃的时长，须与 .lock-passcode-dots[data-shake] 的 animation 对齐 */
const SHAKE_MS = 420;
/** 输对后停顿一下再放行，让第 4 个圆点填上再走 */
const SUCCESS_HOLD_MS = 180;

const KEYPAD: Array<{ digit: string; letters?: string } | null> = [
  { digit: "1" },
  { digit: "2", letters: "ABC" },
  { digit: "3", letters: "DEF" },
  { digit: "4", letters: "GHI" },
  { digit: "5", letters: "JKL" },
  { digit: "6", letters: "MNO" },
  { digit: "7", letters: "PQRS" },
  { digit: "8", letters: "TUV" },
  { digit: "9", letters: "WXYZ" },
  null, // 左下留空（iOS 这里是「紧急情况」）
  { digit: "0" },
  { digit: "delete" },
];

export function LockPasscodePad({
  onUnlocked,
  onNotice,
}: {
  onUnlocked: () => void;
  onNotice?: (text: string) => void;
}) {
  const [input, setInput] = useState("");
  const [shaking, setShaking] = useState(false);
  const [solved, setSolved] = useState(false);
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const successTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => {
    clearTimeout(shakeTimer.current);
    clearTimeout(successTimer.current);
  }, []);

  const submit = useCallback((next: string) => {
    if (verifyPasscode(next)) {
      setSolved(true);
      successTimer.current = setTimeout(onUnlocked, SUCCESS_HOLD_MS);
      return;
    }
    setShaking(true);
    shakeTimer.current = setTimeout(() => {
      setShaking(false);
      setInput("");
    }, SHAKE_MS);
  }, [onUnlocked]);

  const pressDigit = useCallback((digit: string) => {
    if (solved) return;
    setInput((prev) => {
      if (prev.length >= PASSCODE_LENGTH) return prev;
      const next = prev + digit;
      if (next.length === PASSCODE_LENGTH) submit(next);
      return next;
    });
  }, [submit, solved]);

  const pressDelete = useCallback(() => {
    if (solved) return;
    setInput((prev) => prev.slice(0, -1));
  }, [solved]);

  const handleForgot = useCallback(() => {
    if (solved) return;
    resetLockPasscode();
    setInput("");
    onNotice?.(`密码已重置为 ${DEFAULT_PASSCODE}，输入它即可解锁`);
  }, [onNotice, solved]);

  // 物理键盘也支持，桌面端调试方便
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key >= "0" && event.key <= "9") {
        pressDigit(event.key);
        return;
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        pressDelete();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pressDigit, pressDelete]);

  return (
    <div
      className="lock-passcode"
      data-solved={solved ? "1" : undefined}
      // 密码盘上的所有操作都由自己接管，别让它冒泡到锁屏的上滑手势
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      <div className="lock-passcode-inner">
        <div className="lock-passcode-title">输入密码</div>

        <div
          className="lock-passcode-dots"
          data-shake={shaking ? "1" : undefined}
          aria-label={`已输入 ${input.length} 位，共 ${PASSCODE_LENGTH} 位`}
        >
          {Array.from({ length: PASSCODE_LENGTH }).map((_, index) => (
            <span
              key={index}
              className="lock-passcode-dot"
              data-filled={index < input.length ? "1" : undefined}
            />
          ))}
        </div>

        <div className="lock-passcode-keys">
          {KEYPAD.map((key, index) => {
            if (!key) {
              return <span key={`blank-${index}`} className="lock-passcode-key-blank" />;
            }
            if (key.digit === "delete") {
              return (
                <button
                  key="delete"
                  type="button"
                  className="lock-passcode-key lock-passcode-key-plain"
                  onClick={pressDelete}
                  disabled={input.length === 0 || solved}
                  aria-label="删除"
                >
                  <span className="lock-passcode-delete">⌫</span>
                </button>
              );
            }
            return (
              <button
                key={key.digit}
                type="button"
                className="lock-passcode-key"
                onClick={() => pressDigit(key.digit)}
              >
                <span className="lock-passcode-digit">{key.digit}</span>
                {key.letters ? <span className="lock-passcode-letters">{key.letters}</span> : null}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          className="lock-passcode-forgot"
          onClick={handleForgot}
        >
          忘记密码
        </button>
      </div>
    </div>
  );
}
