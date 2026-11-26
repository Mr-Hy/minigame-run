# 排行榜行政区边界

此目录是服务端空间统计使用的 GCJ-02 边界快照。经纬度及包围盒采用 `[longitude, latitude]` 顺序。每个省级文件以 gzip 压缩，保存所属市级区域的多面、内环和外接矩形。`catalog.json` 保存可选区域、名称、编号和外接矩形。

## 数据来源与许可

主数据使用 Cheng Rui、Hu Yunfeng、Xiao Chiwei、Wang Yanjun 发布的 *CTAmap: A continuous vector dataset of Chinese administrative divisions from 2000 to 2026* v2.0，使用 2026 年 1 月 1 日地级快照。原文件为 `T2026_prefecture.gpkg`，SHA-256 为 `6a35915313444d4e669fdc147eade4eb50d67489c38c00f340d871baa624ad85`。作者以 CC BY 4.0 许可开放数据；本项目对原始坐标、几何精度及文件结构做了处理。[数据归档](https://doi.org/10.5281/zenodo.22179207) · [作者说明](https://www.shengshixian.com/pages/d35ae5/) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

台湾省的市县分界采用内政部国土测绘中心的直辖市、县市界线数据，授权为政府资料开放授权条款第 1 版。本项目采用 Daniel Kao 整理的 `taiwan-atlas@2021.9.20/counties-10t.json` 快照，SHA-256 为 `cd4be67df3c7497d3dd49106b17e6f337aeb2466140e4499287799892c15ac7b`。原包 MIT 许可附于同目录。转换后保留台湾本岛及所属离岛的 20 个县市；金门、马祖按主数据归入福建省对应区域，避免重复计入。[原始资料](https://data.gov.tw/dataset/7442) · [资料授权](https://data.gov.tw/license) · [整理说明](https://github.com/dkaoster/taiwan-atlas) · [版本文件](https://cdn.jsdelivr.net/npm/taiwan-atlas@2021.9.20/counties-10t.json)

## 范围与加工

34 个省级区域共有 391 个市级榜单选项，包括地级行政区和省直辖县级单位。四个直辖市、香港和澳门在市级选项中沿用省级编号。台湾省各市县使用项目内六位编号，由 `71` 和源字段 `COUNTYCODE` 的前两位、末两位组成。

1. 从主数据取出地名、区划码、所属省级名称和代码、WGS 84 多边形。mapshaper 0.6.113 在全国同一拓扑上清理覆盖，并以球面 Douglas–Peucker 算法、8 米阈值简化共边。台湾使用补充数据的县市共边。
2. 使用 gcoord 1.0.7 统一换算为 GCJ-02，坐标保留七位小数。清理转换中的微小接缝后逐省拆分，保留闭合环、孔洞与岛屿。简化阈值描述加工步骤；实际边界精度受原图比例尺、快照日期和坐标转换影响。
3. 所有 391 个成品多面均通过 GEOS 的单面有效性和整体覆盖拓扑校验。省内外共边使用相同坐标，海岸、岛屿和内环按数据边界处理。
