"use client";

import { Bot } from "lucide-react";

import type { Character } from "@/lib/character-types";

/** 「写入中」三个字 + 三个跳动的小点：让TA写一篇、定时角色格子里都在用 */
export function DiaryWritingStatus({ label = "写入中" }: { label?: string }) {
  return (
    <span className="diary-writing-status" aria-label={label}>
      <span>{label}</span>
      <span className="diary-writing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

/** 角色头像格子：点一下选中，正在写的角色显示「写入中」 */
export function CharacterAvatarGrid({ characters, selectedIds, busyIds, disabled, onToggle }: {
  characters: Character[];
  selectedIds: string[];
  busyIds: string[];
  disabled: boolean;
  onToggle: (characterId: string) => void;
}) {
  if (characters.length === 0) return <p className="diary-entry-empty-line">暂无角色。</p>;

  return (
    <div className="diary-entry-character-grid">
      {characters.map(character => {
        const selected = selectedIds.includes(character.id);
        const busy = busyIds.includes(character.id);
        return (
          <button
            key={character.id}
            type="button"
            className={selected ? "is-selected" : ""}
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => onToggle(character.id)}
          >
            <span>
              {character.avatar ? <img src={character.avatar} alt="" /> : <Bot size={18} />}
            </span>
            <strong>{character.name}</strong>
            {busy ? <em><DiaryWritingStatus /></em> : null}
          </button>
        );
      })}
    </div>
  );
}
