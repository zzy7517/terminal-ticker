/**
 * 前端领域 DTO 的统一出口。
 *
 * 按领域拆分：agent（Agent/Session/流式）、chat（Shared Message Fabric）、
 * market（行情/交易/新闻）、config（Provider/Proxy 配置）、cron、mcp。
 */
export * from './agent';
export * from './chat';
export * from './config';
export * from './cron';
export * from './market';
export * from './mcp';
