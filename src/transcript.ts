export interface Utterance {
  t_ms: number;
  speaker: string;
  text: string;
}

export interface Fixture {
  name: string;
  description: string;
  utterances: Utterance[];
}
