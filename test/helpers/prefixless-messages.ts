/**
 * Two messages api2 lists with a signature that has no 0x prefix (fetched 2026-11-18), copied as
 * data from `scripts/copies/messages.test.mjs`. The CCN's parsed `content` is left out.
 */
export const PREFIXLESS_MESSAGES = [
  {
    sender: "0x84Dfa9A9B8f7319b150137BdfDd03cc6617b2165",
    chain: "ETH",
    signature:
      "73b3337bfd41cbce9f15e4000ce1a235c4210218e0dee52b0e71b6abfc57" +
      "a0a7201110620b52f9de9ee9677b026c3a3a6cf17ee56150ce6c347855b4" +
      "03610df61c",
    type: "FORGET",
    item_content:
      '{"address":"0x04Ec5b6e169395073F5eF94ED3115891ffE50009","tim' +
      'e":1795023470.8467607,"hashes":["1ee74a13ef0ee65cc08d4e10c19' +
      '43afdaca608cc8be6b97c36affdbecc03b5a5"],"reason":"i7236 spoo' +
      'fed-address forget"}',
    item_type: "inline",
    item_hash: "8c4b3994531dabb38e9d91be97afcf67c828bdd15bcd42b72c2dafc382214b69",
    time: 1795023470.847993,
    channel: null,
  },
  {
    sender: "0x04Ec5b6e169395073F5eF94ED3115891ffE50009",
    chain: "ETH",
    signature:
      "39707386ff50cd1bef4b1d13f9731445b22b21ac4a77481c2af1d413431e" +
      "7412106a6c753b9b6adc692ad888f2c0e73f2882813e7327a882b1cab311" +
      "afb1dd851c",
    type: "AGGREGATE",
    item_content:
      '{"address":"0x04Ec5b6e169395073F5eF94ED3115891ffE50009","tim' +
      'e":1795023470,"key":"security-mark7237","content":{}}',
    item_type: "inline",
    item_hash: "7193682b3ddc094182d1fa82abd9228e8014771caafad715534d04ad3b46dbb6",
    time: 1795023470.671926,
    channel: "TEST",
  },
] as const;

/** The same signature with one hex digit changed. */
export function flipped(signature: string): string {
  return `${signature.startsWith("1") ? "2" : "1"}${signature.slice(1)}`;
}
