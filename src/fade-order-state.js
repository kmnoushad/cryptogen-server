// Only explicit exchange rejection responses prove that this request failed.
// Unknown transport/timeout and duplicate-client-ID responses require lookup.
const REJECTIONS = new Set([-1002,-1003,-1008,-1013,-1014,-1015,-1020,-1021,-1022,
  -1100,-1101,-1102,-1103,-1104,-1105,-1106,-1108,-1109,-1110,-1111,-1112,-1114,-1115,-1116,-1117,-1118,-1119,
  -1120,-1121,-1122,-1126,-1128,-1130,-1136,-2014,-2015,-2016,-2017,-2018,-2019,-2020,-2021,-2022,-2023,-2024,-2025,-2026,-2027,-2028,
  -4001,-4002,-4003,-4004,-4005,-4006,-4007,-4008,-4009,-4010,-4011,-4012,-4013,-4014,-4015,-4016,-4017,-4018,-4019,-4020,-4021,-4022,-4023,
  -4061,-4062,-4130,-4131,-4164]);
export const definiteOrderRejection = e => Number.isInteger(e?.status) && e.status >= 400 && e.status <= 599 && REJECTIONS.has(e.code);
export const rejectionDelay = e => Math.max(e?.retryAfterMs ?? 0, [-1003,-1008,-1015].includes(e?.code) ? 60000 : 5000);
export const safeFault = e => String(e?.message ?? e).replace(/https?:\/\/\S+/g,'[URL redacted]').slice(0,300);
