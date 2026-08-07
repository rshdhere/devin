package agent

import (
	"strings"
	"testing"
)

func TestParseCursorEventRejectsNonJSON(t *testing.T) {
	for _, line := range []string{
		"",
		"   ",
		"Downloading package... 42%",
		"{not json}",
		`{"message":"no type field"}`,
	} {
		if _, ok := parseCursorEvent(line); ok {
			t.Errorf("expected %q to be treated as raw output", line)
		}
	}
}

func TestSummarizeAssistantTextIsPublished(t *testing.T) {
	line := `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Creating the game board"}]}}`
	evt, ok := parseCursorEvent(line)
	if !ok {
		t.Fatal("expected stream event")
	}
	events := summarizeCursorEvent(evt)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Type != "agent.output" {
		t.Errorf("expected agent.output, got %s", events[0].Type)
	}
	if events[0].Message != "Creating the game board" {
		t.Errorf("unexpected message: %q", events[0].Message)
	}
}

func TestSummarizeAssistantStringContent(t *testing.T) {
	line := `{"type":"assistant","message":{"role":"assistant","content":"plain text reply"}}`
	evt, ok := parseCursorEvent(line)
	if !ok {
		t.Fatal("expected stream event")
	}
	events := summarizeCursorEvent(evt)
	if len(events) != 1 || events[0].Message != "plain text reply" {
		t.Fatalf("unexpected events: %+v", events)
	}
}

func TestSummarizeToolCallShapes(t *testing.T) {
	cases := map[string]string{
		`{"type":"tool_call","tool_name":"Read","input":{"path":"src/app/page.tsx"}}`:                                  "Read src/app/page.tsx",
		`{"type":"tool_call","name":"Bash","input":{"command":"npm run build"}}`:                                       "Bash npm run build",
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"a.ts"}}]}}`: "Write a.ts",
	}
	for line, want := range cases {
		evt, ok := parseCursorEvent(line)
		if !ok {
			t.Fatalf("expected stream event for %s", line)
		}
		events := summarizeCursorEvent(evt)
		if len(events) != 1 {
			t.Fatalf("expected 1 event for %s, got %d", line, len(events))
		}
		if events[0].Type != "agent.tool" {
			t.Errorf("expected agent.tool for %s, got %s", line, events[0].Type)
		}
		if events[0].Message != want {
			t.Errorf("for %s expected %q, got %q", line, want, events[0].Message)
		}
	}
}

func TestSummarizeToolCallWithoutDetail(t *testing.T) {
	evt, ok := parseCursorEvent(`{"type":"tool_call","tool_name":"ListDir"}`)
	if !ok {
		t.Fatal("expected stream event")
	}
	events := summarizeCursorEvent(evt)
	if len(events) != 1 || events[0].Message != "ListDir" {
		t.Fatalf("unexpected events: %+v", events)
	}
}

func TestSummarizeResultCarriesDuration(t *testing.T) {
	evt, ok := parseCursorEvent(`{"type":"result","result":"done","duration_ms":4321}`)
	if !ok {
		t.Fatal("expected stream event")
	}
	events := summarizeCursorEvent(evt)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Message != "done" {
		t.Errorf("unexpected message %q", events[0].Message)
	}
	if events[0].Data["durationMs"] != int64(4321) {
		t.Errorf("expected durationMs 4321, got %v", events[0].Data["durationMs"])
	}
}

func TestTruncateMessageBoundsLongPayloads(t *testing.T) {
	long := strings.Repeat("x", maxPublishedMessage+500)
	got := truncateMessage(long)
	if len(got) <= maxPublishedMessage {
		t.Fatalf("expected truncation marker, got len %d", len(got))
	}
	if !strings.HasSuffix(got, "(truncated)") {
		t.Errorf("expected truncation suffix, got tail %q", got[len(got)-20:])
	}
}

func TestSummarizeThinkingAndDeltaTypesAreQuiet(t *testing.T) {
	for _, line := range []string{
		`{"type":"thinking","subtype":"delta"}`,
		`{"type":"thinking","subtype":"completed"}`,
		`{"type":"assistant_delta","subtype":"token"}`,
	} {
		evt, ok := parseCursorEvent(line)
		if !ok {
			t.Fatalf("expected stream event for %s", line)
		}
		if events := summarizeCursorEvent(evt); len(events) != 0 {
			t.Errorf("expected %s to be quiet, got %+v", line, events)
		}
	}
}

// Regression: an unknown event type used to return no events at all, so a CLI
// schema change would silently produce a run with zero visible output.
func TestSummarizeUnknownTypeStillPublishes(t *testing.T) {
	evt, ok := parseCursorEvent(`{"type":"status","subtype":"update"}`)
	if !ok {
		t.Fatal("expected stream event")
	}
	events := summarizeCursorEvent(evt)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Type != "agent.output" {
		t.Errorf("expected agent.output, got %s", events[0].Type)
	}
	if events[0].Message != "status: update" {
		t.Errorf("unexpected message %q", events[0].Message)
	}
}

func TestSummarizeQuietTypesAreSkipped(t *testing.T) {
	for _, line := range []string{
		`{"type":"system","subtype":"init"}`,
		`{"type":"user","message":{"content":[]}}`,
	} {
		evt, ok := parseCursorEvent(line)
		if !ok {
			t.Fatalf("expected stream event for %s", line)
		}
		if events := summarizeCursorEvent(evt); len(events) != 0 {
			t.Errorf("expected %s to be quiet, got %+v", line, events)
		}
	}
}

// Regression: rapid short lines used to be dropped by a 100ms/200-char gate,
// which made active runs look frozen in the UI.
func TestIterCursorJSONObjectsSplitsConcatenated(t *testing.T) {
	line := `{"type":"system","subtype":"init"} {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}`
	parts := iterCursorJSONObjects(line)
	if len(parts) != 2 {
		t.Fatalf("expected 2 objects, got %d", len(parts))
	}
	evt, ok := parseCursorEvent(parts[1])
	if !ok {
		t.Fatal("expected second chunk to parse")
	}
	events := summarizeCursorEvent(evt)
	if len(events) != 1 || events[0].Message != "hello" {
		t.Fatalf("unexpected summarize: %+v", events)
	}
}

func TestSummarizeNestedToolCallStarted(t *testing.T) {
	line := `{"type":"tool_call","subtype":"started","tool_call":{"readToolCall":{"args":{"path":"/workspace/repo/app.py"}}}}`
	evt, ok := parseCursorEvent(line)
	if !ok {
		t.Fatal("expected stream event")
	}
	events := summarizeCursorEvent(evt)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Type != "agent.tool" {
		t.Errorf("expected agent.tool, got %s", events[0].Type)
	}
	if !strings.Contains(events[0].Message, "read") {
		t.Errorf("unexpected message %q", events[0].Message)
	}
	if !strings.Contains(events[0].Message, "app.py") {
		t.Errorf("unexpected message %q", events[0].Message)
	}
}

func TestSummarizeToolCallCompletedIsQuiet(t *testing.T) {
	evt, ok := parseCursorEvent(`{"type":"tool_call","subtype":"completed","tool_call":{"readToolCall":{}}}`)
	if !ok {
		t.Fatal("expected stream event")
	}
	if events := summarizeCursorEvent(evt); len(events) != 0 {
		t.Fatalf("expected quiet completed tool_call, got %+v", events)
	}
}

func TestEveryStreamLineProducesOutput(t *testing.T) {
	lines := []string{
		`{"type":"assistant","message":{"content":[{"type":"text","text":"one"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"two"}]}}`,
		`{"type":"tool_call","tool_name":"Read","input":{"path":"a.ts"}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"three"}]}}`,
	}
	total := 0
	for _, line := range lines {
		evt, ok := parseCursorEvent(line)
		if !ok {
			t.Fatalf("expected stream event for %s", line)
		}
		total += len(summarizeCursorEvent(evt))
	}
	if total != len(lines) {
		t.Fatalf("expected %d published events, got %d", len(lines), total)
	}
}
