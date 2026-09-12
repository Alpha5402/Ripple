# Promise

Promise 表示一个异步操作最终成功或失败的结果。它把「现在发起操作」与「结果到达后做什么」分开，让异步过程可以组合。

## 结果只有一次

一个 Promise 最初处于 pending 状态，随后兑现为 fulfilled，或拒绝为 rejected。一旦落定，状态和结果就不会再改变。`then` 每次返回一个新的 Promise，因此链条中的每一步都可以转换结果，或者继续等待另一个异步操作。

```js
fetch('/api/notes')
  .then(response => {
    if (!response.ok) throw new Error('请求失败');
    return response.json();
  })
  .then(notes => render(notes))
  .catch(error => showError(error));
```

## 回调为什么不会立刻执行

即使结果已经可用，注册的反应也会异步执行。在浏览器中，Promise 反应通过 Microtask 调度，Event Loop 在微任务检查点处理它们。

这解释了一个常见顺序：同步代码先结束，已排队的 Promise 回调随后运行。不断加入新的 Microtask，会推迟浏览器继续处理任务和渲染的机会。

## 组合与边界

Async-Await 把 Promise 链写成更接近顺序执行的形式，但不会把 JavaScript 变成同步阻塞代码。多个独立操作可以先同时启动，再使用 `Promise.all` 等待它们。

Promise 的拒绝不等于底层操作已经停止。取消请求需要由操作本身支持，例如 Fetch 配合 AbortController。计算密集的工作也不会因为包在 Promise 里就离开主线程；这时可以考虑 Web Workers。

> 理解 Promise，需要同时分清结果、调度和操作的生命周期。

继续阅读：[[Async-Await]] 与 [[Event Loop]]。
