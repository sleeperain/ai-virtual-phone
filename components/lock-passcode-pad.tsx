"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
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
  /** 与 input 同步的即时值：点击可能比 setState 更快，读 ref 才准 */
  const inputRef = useRef("");
  const [shaking, setShaking] = useState(false);
  const [solved, setSolved] = useState(false);
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const successTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const setInputSynced = useCallback((next: string) => {
    inputRef.current = next;
    setInput(next);
  }, []);

  /**
   * 键盘分两拍挂载。
   * 之前密码盘一出现，遮罩 + 12 个按键 + 圆点在同一个渲染帧里全部创建并合成，
   * 低配设备会卡到"划不动、等一会儿才亮"，也就是看到的爆闪。
   * 现在先只画标题和圆点（几乎零成本），下一帧再挂键盘，让浏览器分两次合成。
   */
  const [keysReady, setKeysReady] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setKeysReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);

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
      setInputSynced("");
    }, SHAKE_MS);
  }, [onUnlocked, setInputSynced]);

  const pressDigit = useCallback((digit: string) => {
    if (solved) return;
    // 用 ref 读当前值，而不是把 submit 塞进 setInput 的更新函数里：
    // 更新函数可能在渲染阶段被调用多次，里面带副作用（setShaking / 定时器）会重复触发
    const prev = inputRef.current;
    if (prev.length >= PASSCODE_LENGTH) return;
    const next = prev + digit;
    inputRef.current = next;
    setInput(next);
    if (next.length === PASSCODE_LENGTH) submit(next);
  }, [submit, solved]);

  const pressDelete = useCallback(() => {
    if (solved) return;
    const next = inputRef.current.slice(0, -1);
    inputRef.current = next;
    setInput(next);
  }, [solved]);

  const handleForgot = useCallback(() => {
    if (solved) return;
    resetLockPasscode();
    setInputSynced("");
    onNotice?.("密码已重置");
  }, [onNotice, solved, setInputSynced]);

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
      data-keys={keysReady ? "1" : undefined}
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

        <div className="lock-passcode-keys" data-ready={keysReady ? "1" : undefined}>
          {keysReady && KEYPAD.map((key, index) => {
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

        {keysReady && (
          <button
            type="button"
            className="lock-passcode-forgot"
            onClick={handleForgot}
          >
            忘记密码
          </button>
        )}
      </div>
    </div>
  );
}
