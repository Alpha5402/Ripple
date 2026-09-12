# Microtask

Microtask 是一类在特定检查点执行的短小工作。Promise 反应和 `queueMicrotask` 是常见来源。

## 同一轮里收拢变化

当同步代码连续改变多个值时，可以只安排一次微任务，在当前调用栈结束后统一处理。

```js
let scheduled = false;
function scheduleUpdate() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    updateView();
  });
}
```

这个模式利用了微任务的调度位置：当前同步调用先完成，再做一次合并更新。

## 不要把队列当成后台线程

Microtask 仍然在相应的执行环境中运行。递归安排微任务可能阻碍 Event Loop 进入下一个任务和渲染机会。

如果计算本身很重，需要拆分执行或迁移工作。Web Workers 提供独立的执行环境，解决的是不同层面的问题。

关联阅读：[[Promise]]。
