// lib/backpack-types.ts
// 原生背包 · 数据模型
//
// 物品的归属由 recipient 决定：
//   user      我的背包
//   character 某角色的背包（sessionId 指向那个私聊会话）
//   group     某个群的礼物堆（sessionId 指向群会话，giver 记录是谁放进来的）
//
// 关键设计：物品归属是独立数据，不再从聊天消息反推。
// 老版本送礼功能把「是否已送出」记在 gift 消息上，清空聊天记录会连带
// 把送出状态一起抹掉，商品于是重新出现在可送列表里——那是背包要根治的 bug。

import type { CheckPhoneShoppingTone } from "./checkphone-config";

/** 物品归属 */
export type BackpackRecipient = "user" | "character" | "group";

/** 物品放入群礼物堆时的投放者身份 */
export type BackpackGiverRole = "user" | "assistant";

/**
 * 来自购物订单的物品来源信息。
 * 带这个字段的物品，来源（店铺名）、购买时间、详情由订单锁定，界面上只读。
 */
export type BackpackShoppingOrigin = {
    orderId: string;
    itemId: string;
    unitIndex: number;
    /** 店铺名 */
    merchantLabel: string;
    priceLabel: string;
    /** 商品详情文案 */
    detail: string;
    previewIcon?: string;
    tone?: CheckPhoneShoppingTone;
    /** 到货时间（ISO） */
    deliveredAt?: string;
};

export type BackpackItem = {
    id: string;
    /** 物品名称 */
    title: string;
    /** 来源 / 赠予人。购物来源时即店铺名，且不可改 */
    source: string;
    /** 价值展示文案，如 "29.90" */
    value: string;
    /** 记录时间，形如 "09/12 14:30" */
    date: string;
    /** 物品备注 / 背景说明 */
    note: string;
    /** 自定义图标（data URL 或 http 地址），空串表示用默认礼物图标 */
    customImage: string;
    /** 购物订单的商品图标，用于送出时还原卡片外观 */
    previewIcon?: string;
    tone?: CheckPhoneShoppingTone;

    recipient: BackpackRecipient;
    /** recipient 为 character / group 时指向对应会话；user 物品为空串 */
    sessionId: string;

    /** 角色背包物品是否注入角色提示词 */
    injected: boolean;
    /** 我的背包 / 群礼物堆物品对哪些会话的角色可见（会话 id 列表） */
    visibleTo: string[];

    /** 用户手动添加 */
    isManual: boolean;
    /** 角色通过标记自行添加 */
    isRoleAdded: boolean;
    /** 用户编辑过：批量扫描时不覆盖 */
    userEdited: boolean;

    /** 排序用时间戳 */
    timestamp: number;

    /** recipient 为 group 时：谁放进礼物堆的 */
    giver?: string;
    giverRole?: BackpackGiverRole;

    /** 购物订单来源；存在即表示来源 / 时间 / 详情锁定 */
    shopping?: BackpackShoppingOrigin;
};

/** 转送目标白名单：来源 id → 允许放入的目标 id 列表 */
export type BackpackTransferTargets = Record<string, string[]>;

export type BackpackTransferTarget = {
    id: string;
    /** 下拉框里的完整名称，如「【小卷】的背包」 */
    name: string;
    /** 角色名 / 群名 */
    rawName: string;
    isUser: boolean;
    isGroup: boolean;
    sessionId?: string;
};

/** 背包数据变化广播 */
export const BACKPACK_CHANGED_EVENT = "backpack-changed";
