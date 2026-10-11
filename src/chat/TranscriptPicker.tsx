import type { Located } from "../lib/types";

const basename = (p: string) => p.split("/").pop() ?? p;

export const transcriptKey = (paneKey: string) => `herdly:transcript:${paneKey}`;

export function rememberedTranscript(paneKey: string): string | null {
  try {
    return localStorage.getItem(transcriptKey(paneKey));
  } catch {
    return null;
  }
}

export function rememberTranscript(paneKey: string, path: string) {
  try {
    localStorage.setItem(transcriptKey(paneKey), path);
  } catch {
    /* ignore */
  }
}

export function forgetTranscript(paneKey: string) {
  try {
    localStorage.removeItem(transcriptKey(paneKey));
  } catch {
    /* ignore */
  }
}

export function TranscriptPicker({ located, onChoose }: { located: Located; onChoose: (path: string) => void }) {
  if (!located.ambiguous) return null;
  const options = located.candidates.includes(located.path) ? located.candidates : [located.path, ...located.candidates];
  return (
    <div className="chat-notice">
      <span>This may not be this pane's conversation</span>
      <select aria-label="Transcript" value={located.path} title={located.path} onChange={(e) => onChoose(e.target.value)}>
        {options.map((c) => (
          <option key={c} value={c} title={c}>
            {basename(c)}
          </option>
        ))}
      </select>
    </div>
  );
}
