// 在同一个进程里跑全部单元测试。
// 不用 `node --test test/*.test.mjs`：DSH 沙箱禁止 spawn 子进程，测试运行器会 EPERM。
import './config.test.mjs';
import './memory-card.test.mjs';
import './memory.test.mjs';
import './server.test.mjs';
import './patch-dsh-pet.test.mjs';
import './orphan-guard.test.mjs';
import './degraded.test.mjs';
