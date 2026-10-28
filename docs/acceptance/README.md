# 本地浏览器验收证据

所有截图使用独立临时数据库与明确标注的合成数据，不包含真实课题组Excel、访谈或生产论文统计。不是对生产部署结果的声明。

| 页面 | 1440 | 1024 | 390 |
| --- | --- | --- | --- |
| 学术情报 | [截图](radar-1440.png) | [截图](radar-1024.png) | [截图](radar-390.png) |
| 七张ECharts | [截图](trends-1440.png) | [截图](trends-1024.png) | [截图](trends-390.png) |
| 项目里程碑/成员 | [截图](lab-project-1440.png) | [截图](lab-project-1024.png) | [截图](lab-project-390.png) |
| 共享论文表 | [截图](manuscripts-1440.png) | [截图](manuscripts-1024.png) | [截图](manuscripts-390.png) |

- [Excel导入预览](excel-preview-1440.png)
- [文本建议人工审批](document-review-1440.png)
- [浏览器脚本结果](browser-results.json)
- [Node22容器测试](node22-tests.txt)、[Node24测试](node24-tests.txt)、[Node22覆盖率](node22-coverage.txt)

复现：`python scripts/browser-acceptance.py`。环境和人工生产验收步骤见 [运维手册](../OPERATIONS_V1_2.md)。
