declare module 'signalsmith-stretch' {
  const SignalsmithStretch: (ctx: BaseAudioContext, options?: AudioWorkletNodeOptions) => Promise<AudioWorkletNode>;
  export default SignalsmithStretch;
}
