// lib/backpack-types.ts
// 原生背包 · 数据模型
//
// 物品只有两种归属：
//   user      我的背包
//   character 某个角色的背包（characterId 指向角色，不依赖是否有私聊会话）
//
// 因为归属挂在角色身上，群聊里某角色收到的东西也进他自己的背包，
// 提示词可以按角色逐个注入（群聊一次请求里每个成员各拿到自己那份）。
//
// 关键设计：物品归属是独立数据，不再从聊天消息反推。
// 老版本送礼功能把「是否已送出」记在 gift 消息上，清空聊天记录会连带
// 把送出状态一起抹掉，商品于是重新出现在可送列表里——那是背包要根治的 bug。

import type { CheckPhoneShoppingTone } from "./checkphone-config";

/** 物品归属 */
export type BackpackRecipient = "user" | "character";

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
    /** recipient 为 character 时归属的角色 id；user 物品为空串 */
    characterId: string;

    /** 角色背包物品是否注入该角色的提示词 */
    injected: boolean;
    /** 我的背包物品对哪些角色可见（角色 id 列表） */
    visibleTo: string[];

    /** 用户手动添加 */
    isManual: boolean;
    /** 角色通过标记自行添加 */
    isRoleAdded: boolean;
    /** 用户编辑过：批量扫描时不覆盖 */
    userEdited: boolean;

    /** 排序用时间戳 */
    timestamp: number;

    /** 购物订单来源；存在即表示来源 / 时间 / 详情锁定 */
    shopping?: BackpackShoppingOrigin;

    /**
     * 旧版（会话归属）遗留字段，仅用于一次性迁移：
     * v1 数据按会话 id 归属，迁移时换算成 characterId 后清空。
     * 运行时逻辑一律不读它。
     */
    legacySessionId?: string;
};

/** 背包目标：我的背包，或某个角色的背包 */
export type BackpackTarget = {
    /** "user" 或角色 id */
    id: string;
    /** 下拉/标题里展示的完整名称，如「【小卷】的背包」 */
    name: string;
    /** 角色名；我的背包为「我的背包」 */
    rawName: string;
    isUser: boolean;
    /** 绑定的角色 id（仅角色目标） */
    characterId?: string;
};

/** 传送白名单：来源 id → 允许放入的目标 id 列表 */
export type BackpackTransferTargets = Record<string, string[]>;

/** 背包数据变化广播 */
export const BACKPACK_CHANGED_EVENT = "backpack-changed";
