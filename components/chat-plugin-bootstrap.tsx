"use client";

// components/chat-plugin-bootstrap.tsx
// 聊天插件运行时启动引导：应用挂载后加载全部启用插件。
// 放在根布局，保证插件的 hook 在用户进入聊天前就已注册。

import { useEffect } from "react";
import { getChatPluginRuntime } from "@/lib/chat-plugin-runtime";
import { ensureBackpackMigrated } from "@/lib/backpack-storage";

// 副作用 import：lib/backpack-legacy 会把自己注册成背包的一次性迁移 runner。
// 必须在这里 import，不能放进 backpack-storage —— 它会 import chat-storage，
// 而 chat-storage 又依赖背包标记，反向 import 会形成循环依赖。
import "@/lib/backpack-legacy";

export function ChatPluginBootstrap() {
    useEffect(() => {
        void getChatPluginRuntime().ensureStarted();
        // runner 注册完，主动跑一次迁移，别等用户第一次打开背包才搬数据
        try {
            ensureBackpackMigrated();
        } catch (e) {
            console.warn("[backpack] 启动迁移失败", e);
        }
    }, []);
    return null;
}
