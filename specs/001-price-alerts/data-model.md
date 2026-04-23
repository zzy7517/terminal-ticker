# 数据模型：价格提醒

## 1. AlertRuleConfig（提醒规则）

- **作用**：描述某个 symbol 的一条提醒规则。
- **核心字段**：
  - `direction`: 高于 / 低于
  - `price`: 阈值价格
  - `label`: 可选名称
- **校验**：
  - `price` 必须是正数
  - `direction` 必须合法
  - 规则只能配在 watchlist 已有 symbol 上

## 2. AlertRuntimeState（运行时状态）

- **作用**：记录一条规则当前能不能触发、是否已经触发。
- **核心状态**：
  - `armed`
  - `triggered`
  - `unknown`
- **状态流转**：
  - `unknown -> armed`：有了可用基准价
  - `armed -> triggered`：新鲜行情真实穿越阈值
  - `triggered -> armed`：价格回到另一侧
  - `* -> unknown`：行情变 stale / unusable

## 3. AlertEvent（提醒事件）

- **作用**：一次用户看得见的提醒。
- **信息**：
  - 哪个 symbol
  - 哪条规则
  - 触发价格
  - 触发方向
- **生命周期**：
  - 触发时生成
  - 短暂显示
  - 消失后不影响正常价格展示

## 4. Quote Freshness State（行情新鲜度）

- **作用**：判断当前价格能不能参与提醒计算。
- **判断因素**：
  - 有没有 price
  - 是不是真实 quote
  - 有没有 stale
  - 是否处于 reconnect gap
- **规则**：
  - 只要新鲜度不可信，就不能触发提醒
  - 恢复后也要重新建立安全基线
