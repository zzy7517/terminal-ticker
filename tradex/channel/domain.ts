/**
 * Channel 领域类型 —— wire 形状统一定义在 tradex/contracts.ts，这里保持
 * 原导出路径 re-export。ChatTarget 及其辅助函数住在 chat/target.ts。
 */
export type {
  Channel,
  ChannelMessage,
  ChannelReactionSummary,
  HeldDraft,
  HeldDraftStatus,
  ChannelReminder,
  ReminderStatus,
} from "../contracts.js";
