class MayhemMic extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(Float32Array.from(ch));
    return true;
  }
}
registerProcessor('mayhem-mic', MayhemMic);
