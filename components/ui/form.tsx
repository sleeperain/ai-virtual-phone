"use client";

import { useState, useEffect, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes, type ReactNode } from "react";

/* ── Input ── */
type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  className?: string;
};

export function Input({ className, ...rest }: InputProps) {
  return <input className={`ui-input ${className ?? ""}`} {...rest} />;
}

/* ── Textarea ── */
type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  className?: string;
};

export function Textarea({ className, ...rest }: TextareaProps) {
  return <textarea className={`ui-textarea ${className ?? ""}`} {...rest} />;
}

/* ── Select ── */
type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  className?: string;
  children: ReactNode;
};

export function Select({ className, children, ...rest }: SelectProps) {
  return (
    <select className={`ui-select ${className ?? ""}`} {...rest}>
      {children}
    </select>
  );
}

/* ── Toggle ── */
export function Toggle({
  checked,
  onChange,
  className,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`ui-toggle ${className ?? ""}`}
      data-ui="toggle"
      data-checked={checked ? "" : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-toggle-knob" />
    </button>
  );
}

/* ── Slider (param row with label + value display) ── */
export function Slider({
  label,
  value,
  displayValue,
  hint,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  displayValue?: string;
  hint?: string;
}) {
  return (
    <div className={`ui-slider-row ${className ?? ""}`}>
      <span className="ui-slider-label">{label}</span>
      <input type="range" className="ui-slider" data-ui="slider" value={value} {...rest} />
      {displayValue !== undefined && <span className="ui-slider-value">{displayValue}</span>}
      {hint && <span className="ui-slider-hint">{hint}</span>}
    </div>
  );
}

/* ── Avatar Upload ── */
export function AvatarUpload({
  src,
  onClick,
  className,
}: {
  src?: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button type="button" className={`ui-avatar-upload ${className ?? ""}`} onClick={onClick}>
      {src ? (
        <img src={src} alt="avatar" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "inherit" }} />
      ) : (
        <span className="ui-avatar-upload-placeholder">+</span>
      )}
      <span className="ui-avatar-upload-overlay">更换</span>
    </button>
  );
}

function normalizeHexColor(raw: string): string | null {
  const cleaned = raw.trim().replace(/^#+/, "");
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return `#${cleaned.toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
    const expanded = cleaned
      .split("")
      .map((ch) => ch + ch)
      .join("");
    return `#${expanded.toLowerCase()}`;
  }
  return null;
}

/* ── Color Input ── */
export function ColorInput({
  value,
  onChange,
  label,
  className,
  showHexInput = false,
}: {
  value: string;
  onChange: (color: string) => void;
  label?: string;
  className?: string;
  showHexInput?: boolean;
}) {
  const [hexDraft, setHexDraft] = useState(value || "#000000");

  useEffect(() => {
    setHexDraft(value || "#000000");
  }, [value]);

  const pickerValue = normalizeHexColor(value) ?? "#000000";

  if (!showHexInput) {
    return (
      <label className={`ui-color-input ${className ?? ""}`}>
        <input
          type="color"
          value={pickerValue}
          onChange={(e) => onChange(e.target.value)}
        />
        {label && <span>{label}</span>}
      </label>
    );
  }

  const commitDraft = () => {
    const normalized = normalizeHexColor(hexDraft);
    if (normalized) {
      setHexDraft(normalized);
      if (normalized.toLowerCase() !== (value || "").toLowerCase()) {
        onChange(normalized);
      }
    } else {
      setHexDraft(value || "#000000");
    }
  };

  return (
    <div className={`ui-color-input ui-color-input--with-hex ${className ?? ""}`}>
      <input
        type="text"
        className="ui-color-hex-field"
        value={hexDraft}
        placeholder="#8FB2C8"
        maxLength={7}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => {
          const next = e.target.value;
          setHexDraft(next);
          if (/^#?[0-9a-fA-F]{6}$/.test(next.trim())) {
            const normalized = normalizeHexColor(next);
            if (normalized) onChange(normalized);
          }
        }}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitDraft();
          }
        }}
      />
      <input
        type="color"
        value={pickerValue}
        onChange={(e) => {
          setHexDraft(e.target.value);
          onChange(e.target.value);
        }}
      />
      {label && <span>{label}</span>}
    </div>
  );
}
