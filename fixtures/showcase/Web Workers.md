# Web Workers

Web Workers 让脚本在与页面主线程分开的执行环境里运行。适合迁移的工作包括较重的解析、索引和数据转换。

## 通过消息协作

Worker 不能直接操作页面 DOM。主线程与 Worker 使用消息传递数据，通常经过结构化克隆；某些资源也可以转移所有权。

```js
const worker = new Worker(new URL('./indexer.js', import.meta.url), {
  type: 'module',
});
worker.postMessage({ type: 'index', revision: 7, markdown });
worker.onmessage = ({ data }) => {
  if (data.revision === currentRevision) showIndex(data.result);
};
```

## 结果还需要版本

把计算迁到另一处，不会自动解决过期响应。用户在计算期间切换文档、修改正文或者关闭工作区时，返回结果仍需验证身份与版本。

Promise 可以包装一次消息往返，让调用方更方便地等待结果；这只是组织方式，计算是否离开主线程取决于工作实际在哪里执行。

当生产结果比消费速度更快时，还要限制排队量。这个问题与 [[Backpressure|背压]] 的思路相通。
