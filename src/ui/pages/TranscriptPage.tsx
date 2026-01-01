import { useMemo, useState } from "react";
import type { ProjectDoc, TranscriptSegment } from "../../core/types/project";

const formatTimestamp = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const buildSegmentLabel = (segment: TranscriptSegment): string => {
  const hasRange = segment.endMs > segment.startMs;
  if (!hasRange) {
    return formatTimestamp(segment.startMs);
  }
  return `${formatTimestamp(segment.startMs)} - ${formatTimestamp(
    segment.endMs,
  )}`;
};

type Props = {
  project: ProjectDoc;
  onBack: () => void;
};

export function TranscriptPage({ project, onBack }: Props) {
  const segments = useMemo(
    () => project.transcript?.segments ?? [],
    [project.transcript?.segments],
  );
  const [searchTerm, setSearchTerm] = useState("");
  const sortedSegments = useMemo(
    () => [...segments].sort((a, b) => a.startMs - b.startMs),
    [segments],
  );
  const normalizedQuery = searchTerm.trim().toLowerCase();
  const isSearching = normalizedQuery.length > 0;
  const filteredSegments = useMemo(() => {
    if (!isSearching) {
      return sortedSegments;
    }
    return sortedSegments.filter((segment) =>
      segment.text.toLowerCase().includes(normalizedQuery),
    );
  }, [isSearching, normalizedQuery, sortedSegments]);
  const hasTranscript = segments.length > 0;
  const noMatches =
    hasTranscript && isSearching && filteredSegments.length === 0;

  return (
    <div className="hm-transcript-page">
      <header className="hm-transcript-pageHeader">
        <div className="hm-transcript-pageHeaderRow">
          <button
            type="button"
            className="hm-button hm-button--ghost hm-button--compact"
            onClick={onBack}
          >
            Back
          </button>
          <div className="hm-transcript-pageHeaderTitle">
            <span className="hm-transcript-pageTitle">Transcript</span>
            <span className="hm-transcript-pageCount">
              {segments.length} segments
            </span>
          </div>
          <div className="hm-transcript-pageSearch">
            <input
              type="search"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.currentTarget.value)}
              placeholder="Search transcript"
              aria-label="Search transcript"
            />
          </div>
        </div>
        {noMatches && (
          <div className="hm-transcript-pageSearchHint">
            No transcript lines match "{searchTerm}". Try a different keyword.
          </div>
        )}
      </header>
      <div className="hm-transcript-pageBody">
        {!hasTranscript ? (
          <div className="hm-transcript-empty">
            <p className="muted">
              No transcript yet. Import or generate one to explore your content.
            </p>
          </div>
        ) : noMatches ? (
          <div className="hm-transcript-empty">
            <p className="muted">
              No matching transcript lines. Clear your search to browse
              everything.
            </p>
          </div>
        ) : (
          <div className="transcript-list">
            {filteredSegments.map((segment) => (
              <div key={segment.id} className="transcript-segment">
                <div className="transcript-timestamp">
                  {buildSegmentLabel(segment)}
                </div>
                <div className="transcript-text">{segment.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
