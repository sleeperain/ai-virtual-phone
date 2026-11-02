"use client";

// components/chat-plugin-bootstrap.tsx
// 聊天插件运行时启动引导：应用挂载后加载全部启用插件。
// 放在根布局，保证插件的 hook 在用户进入聊天前就已注册。

import { useEffect } from "react";
import { getChatPluginRuntime } from "@/lib/chat-plugin-runtime";
// 这条 import 同时完成两件事：把 runner 注册进 backpack-storage，
// 以及拿到需要「等水合完成」的异步引导函数。
// 不能放进 backpack-storage —— 它会 import chat-storage，而 chat-storage
// 又依赖背包标记，反向 import 会形成循环依赖。
import { initBackpackMigration } from "@/lib/backpack-legacy";

export function ChatPluginBootstrap() {
    useEffect(() => {
        void getChatPluginRuntime().ensureStarted();
        // 迁移要读 kv / 购物订单 / 会话，三者都是异步水合的。
        // 必须等水合完再跑，否则读到空数据会把版本标记写错。
        void initBackpackMigration();
    }, []);
    return null;
}
