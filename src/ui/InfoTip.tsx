import { InfoIcon } from "./icons";

/**
 * An ⓘ that shows `text` on hover. Hidden from the accessibility tree so it stays out of a label's name;
 * point the field's `aria-describedby` at `id` to have the text read as its description.
 */
export function InfoTip({ id, text }: { id: string; text: string }) {
  return (
    <span className="info-tip" aria-hidden="true">
      <InfoIcon />
      <span id={id} className="info-tip-text">{text}</span>
    </span>
  );
}
