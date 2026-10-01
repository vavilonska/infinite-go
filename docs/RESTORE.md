# 存档恢复与终局模式 / Save restoration and result modes

源码支持不等于两个在线站点都已部署；新功能需更新对应前端和后端。已有对局和旧存档不会自动改规则。

## 新局

每次新开局必须主动选择 9 / 13 / 19 路。界面默认加权目差、贴目补偿剪枝、C32。目差终局按各叶最终权重乘白方含有效贴目的最终目差求和，等全部结算后才判胜；正白、负黑、零和棋。精确有理数计算，普通百分比仅展示。

认输剪枝在目差模式下使用开局约定的固定输分，默认20目，可选0.5至1000的半目整数倍。黑认输为正、白认输为负；每条受影响叶只计一次。此参数仅在目差模式的认输剪枝设置中开放。切换设置不会修改已进行的棋局。

旧的加权胜负模式仍可选，按实际胜盘权重判定；默认改变不把旧局转成新模式。AI 的胜率加权图仍只是胜负权重预测，不是目差预测或正式结算。

## JSON 内容及兼容性

导出包含全部棋线历史、精确权重、双方独立轮次、分叉/剪枝参数、补偿账本、归档、死子与计分确认、已结算结果。新版保存格式为 v3；导入 v1/v2 默认保留加权胜负。导入会重放历史、检查权重/账本/终局，而非盲信文件里的结果。未知未来格式拒绝，不能保证任意未来版本兼容。

不导出房间凭据、服务器房间寿命、席位恢复授权或临时同屏猜先状态。文件不是旧房间所有权证明。分享 JSON 会分享棋局本身，请仅发给愿意让其看到的人。

## 恢复在线对局

创建朋友房间时选择“从 JSON 恢复为新房间”，选择文件，核对摘要；棋盘尺寸和规则取自存档，不另改。房主选择自己的原执色；对手通过新房间码重新加入另一个颜色。双方查看棋盘和时间线并确认后才可续弈，旁观者不能确认。

恢复生成全新房间、席位凭据和寿命，不覆盖或删除原房，不自动继承旧玩家身份。导入者可在上传前改一个合法文件，因此双方确认局面是必要的信任边界；这里不提供竞技级历史来源证明。

托管恢复上限约96 KB、128条棋线记录（含归档）、每线512步、合计2048步，同时仍受最终房间状态容量限制。超限拒绝，不截断棋线、不擅改棋规；可以继续本地同屏。局域网恢复使用相同保守限制。普通落子请求仍限制4 KiB，仅创建恢复房间接受较大、有界的请求。

局域网房间在主机内存中；重启会丢失服务器副本，须提前导出。远程房间到期或平台不可用时，导出已收到的副本并约定新房恢复。不要为更新网页而强制刷新对局。

## English

New-game UI requires explicit board-size selection and defaults to weighted score margin with komi-compensation pruning. Older saves retain weighted wins. Version3 stores result mode and the agreed resignation margin; versions1/2 migrate conservatively. Exact arithmetic includes effective/frozen komi once. The winner in margin mode is determined only after all boards settle.

Restore creates a new friend room with fresh credentials. Saved rules and size are retained; the importer chooses their previous color, the other player rejoins, and both confirm the position before actions are accepted. Spectators cannot confirm. This does not recover ownership of the original room or overwrite it. Files contain game state, not player credentials, and are consistency-checked rather than treated as provenance proof. Hosted capacity limits reject oversized saves without truncation; local play remains available. Each backend must be upgraded before offering online restoration.
