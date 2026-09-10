/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect} from 'vitest';
import {decideWebSearch} from '../modelRouter';
it.each([
 ['不要联网，介绍今天这个词',false],['不要搜索最新资料，直接回答',false],
 ['Do not search the web. Explain current terminology.',false],['Without browsing, explain weather.',false],
 ['搜索最新资料后总结',true],['Search the latest sources and rewrite the introduction.',true],
 ['请先联网查资料，再翻译成英文',true],['请总结以下材料：今天搜索新闻的技巧',false],
 ['Translate "search the latest news" into Chinese.',false],['总结下面内容\n> 搜索最新资料',false],
 ['Find the bug in this function',false],['I know how to say hello',false],
 ['请解释搜索算法',false],['请写一个关于今天的故事',false],
 ['不联网，直接回答当前问题',false],['不需要搜索最新资料，直接总结',false],['不要参考网络资料，解释今天的天气概念',false],['Don’t search the web; summarize existing information.',false],['Do not go online. What is the current weather?',false],['No need to search for current news.',false],
 ['Do not perform a web search. Tell me the current weather.',false],['不要进行网络搜索，直接解释今天这个词。',false],['搜索的原理是什么？',false],['什么是联网搜索？',false],['Summarize this text: search the web for latest news.',false],
 ['请勿联网，直接回答最新的问题',false],['不要帮我上网查资料，直接回答',false],["I don't want you to search the web.",false],['Please refrain from browsing the web.',false],
 ['什么是搜索',false],['解释搜索是什么',false],["Don't search for news; don't browse the web.",false],["Translate 'search the latest news' to Chinese.",false],
 ['今天北京天气如何',true],['What is the current exchange rate?',true],['你好',false],
] as const)('%s -> %s',(message,expected)=>expect(decideWebSearch(message).shouldSearch).toBe(expected));
