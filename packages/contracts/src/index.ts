// ============================================================
// 共享类型 + 接口契约 —— 「缝」的物理位置。
// client 和 server 都只依赖这里，不依赖对方内部实现。
// 未来记忆 / MBTI / 时间各自实现下面的接口，L3 大脑一行不改。
// 按域拆成子文件（affect / safety / coach / memory / time / persona / selfAdded），
// 这里只 re-export；对外 API 不变。
// ============================================================

export * from './affect';
export * from './safety';
export * from './coach';
export * from './memory';
export * from './time';
export * from './persona';
export * from './selfAdded';
