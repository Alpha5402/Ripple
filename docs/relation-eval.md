# K5：关系评估

本轮建立了可重复运行的分级评估，并用真实 WeMM 向量比较确定关系、语义关系和 Hybrid。结论限定在固定参考样本：语义能补上同义改写与互补内容；显式关系有助于排序，但“提到了某词”也会把难负例带回来。Hybrid 并非始终优于纯语义。

## 数据与标签

[reference-v1.json](../fixtures/eval/reference-v1.json) 包含 32 篇短文、240 对完整候选判断。开发与测试各 16 篇不同文档，每组 120 对；每个中心使用完全相同的另外 15 篇文档，三种方案都按这个候选池计算，不用各自召回结果的大小充当分母。

标签是 **assistant-authored-synthetic-reference，未经过用户人工复核**。0=无关、1=弱相关、2=值得一起读、3=核心关联；分布为 212/4/16/8。每一对都有理由与来源。24 对 hard negative 包含同名异义、词元与身份凭据、相似但不同领域的虚构设备型号。短文刻意设置提及、显式链接和不依赖名称的语义解释，不能代表自然 Wiki 的关系比例、写作长度或困难程度。

测试文档与开发文档不重叠，不在测试集上选择分数参数。模型固定为 [tencent/WeMM-Embedding-2B](https://huggingface.co/tencent/WeMM-Embedding-2B)，revision `bbd6cd4bf52cfc6716f752a2df80b2706720bd95`，MPS/BF16、2048 维。32 篇各编码为一个单元；原始向量留在本地，240 对特征及模型标识可随仓库复查。

## 指标与校准

相关答案定义为 grade≥2。P@3 使用固定分母 3；这里有答案的每个中心恰好有两个正例，因此理论上限为 2/3。nDCG@3 使用 `(2^grade−1)/log2(rank+1)`。两者对有正例的 12 个中心取均值；另 4 个无正例中心单独统计是否误展示。零分不会被伪装成已召回结果。分数相同按关系 ID 排序。

展示误召回在固定 Lens=50，即分数≥0.5 下统计，不与 Top-3 排序混为一谈。hard-negative rate 以测试集 12 对难负例为分母；普通无关对和有用但没展示的样本也单独输出。

开发集只尝试余弦映射下界 `[0.2, 0.35, 0.5, 0.65]`，上界固定 0.9；目标为 `nDCG@3 + 0.5 P@3 − 0.5 难负例误展示率 − 0.25 无正例中心误展示率`。选择了下界 **0.5**，与 0.65 的目标值持平，按事先固定的较低下界规则取值。`mention-explicit-v1` 的参数保持不变；保存锁定文件之后才运行测试指标。文件已存在时校准程序拒绝静默覆盖。

这份校准仍是实验结果，**未替换默认配置**。默认映射下界仍为 0.2。要尝试实验映射，显式把 `retrieval.mappings.text-text.min` 设为 0.5，并使用新的 retrieval.version；它不改变向量空间，可以复用编码。图文映射没有使用这些文本标签调参。

## 独立测试集观察

| 映射 | 方法 | P@3 | nDCG@3 | 难负例误展示 | 有用但未展示 |
| --- | --- | ---: | ---: | ---: | ---: |
| 默认 0.2～0.9 | Mention+Explicit | 0.4444 | 0.7835 | 1/12 | 8/12 |
| 默认 0.2～0.9 | Semantic | 0.6667 | 0.9452 | 4/12 | 0/12 |
| 默认 0.2～0.9 | Hybrid | 0.6667 | 0.9264 | 4/12 | 0/12 |
| 开发集锁定 0.5～0.9 | Mention+Explicit | 0.4444 | 0.7835 | 1/12 | 8/12 |
| 开发集锁定 0.5～0.9 | Semantic | 0.6667 | 0.9452 | 0/12 | 6/12 |
| 开发集锁定 0.5～0.9 | Hybrid | 0.6667 | 0.9694 | 1/12 | 3/12 |

- **有效的部分**：纯文本解释可以建立没有直接名称引用的关联；同一候选预算下，Semantic/Hybrid 的 P@3 高于只靠提及与链接。锁定映射后，Hybrid 的显式增强保留了一部分纯语义未达到展示阈值的有用对。
- **没有优势的部分**：默认映射下，Hybrid 的 nDCG 低于纯语义；增强某个显式链接并不保证整体排序更好。收紧映射虽然减少误展示，也让部分有用对低于阈值，P@3 高不能掩盖这个召回损失。
- **保留的难负例**：`SG-240 空压机 ↔ SG-240A 收款终端`。后者正文明确说明与前者没有兼容关系，但仍形成真实名称提及，M=0.5。锁定映射下，纯语义分约 0.4757，Hybrid 被提及基分抬到 0.5。这说明当前 Mention 只识别存在性，不能理解否定语境；提高语义阈值无法消除这个错误。

[测试报告](../reports/k5/test-results.json) 保留逐中心排名、误展示和漏展示；[开发集锁定记录](../reports/k5/locked-policy.json) 保留网格和选择规则；[特征](../reports/k5/features.json) 可在不启动模型时复算。规模小、人工标签未复核，不据此声称显著提升或最终产品质量达标。

## 复跑

不需要模型即可复算本次锁定测试：

```sh
npm run eval:relations -- --stage replay
```

从模型重新生成特征并重现完整流程：

```sh
npm run wemm:start
npm run eval:relations -- --stage encode
npm run eval:relations -- --stage calibrate
npm run eval:relations -- --stage test
```

输出在 `reports/local/eval-v1/`。已有 locked-policy 时不要为了让测试更好看而覆盖它；新的调参实验应使用新数据版本和预留的新测试集。encode 可复用相同数据哈希下的已完成单元，逐篇写检查点。

## 真实 Wiki 的发现记录

已只读索引 iWiki 的 77 篇笔记、386 个真实 WeMM 单元，coverage=ready。索引前后 Markdown 列表与 SHA-256 一致。默认宽松映射召回了 2812 对纯语义候选，说明“召回了”本身远远不等于“有用”；从中按分数及单篇最多参与三次的规则保留 40 对复核样本。

私有原文与证据只保存在 `reports/local/wiki-eval/review-queue.json`。每对有标题、路径、两端 revision/原文范围和下面的待填字段：

```json
{
  "relationId": "来自队列的关系 ID",
  "grade": 2,
  "previouslyKnown": false,
  "wouldHaveSearched": false,
  "usefulAfterReading": true,
  "reviewer": "实际复核者",
  "reviewedAt": "ISO 日期",
  "note": "复核理由"
}
```

只有 grade≥2、读后认为有用、之前不知道且不会主动搜索，才计入 unexpectedUseful。**目前已确认数量为 0，等待真实人工判断。** 上面只是格式示例，不是已完成的评审。

```sh
npm run eval:wiki -- --vault /Users/alpha/Documents/ChatGPT/iWiki
npm run eval:wiki -- --annotations /absolute/path/human-reviews.json
```

标注文件为对象数组；导入校验已有 pair ID、等级、三个布尔判断、复核人和时间，不会用模型分数代填用户判断。K5 的评估工具、参考基准和反例分析已交付，真实用户“意外但有用”的验收仍待这些标注。
