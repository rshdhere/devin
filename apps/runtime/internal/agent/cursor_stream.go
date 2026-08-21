package agent

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// maxPublishedMessage bounds a single event message. Agent payloads (file
// contents, diffs) can be megabytes and would otherwise flood the event bus.
const maxPublishedMessage = 2000

type cursorStreamEvent struct {
	Type     string          `json:"type"`
	Subtype  string          `json:"subtype"`
	IsError  bool            `json:"is_error"`
	Result   string          `json:"result"`
	Duration int64           `json:"duration_ms"`
	Message  json.RawMessage `json:"message"`
	Name     string          `json:"name"`
	Tool     string          `json:"tool"`
	ToolName string          `json:"tool_name"`
	Input    json.RawMessage `json:"input"`
	ToolCall json.RawMessage `json:"tool_call"`
}

type cursorMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type cursorContentPart struct {
	Type  string          `json:"type"`
	Text  string          `json:"text"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

// publishedEvent is a human-readable projection of one stream-json line.
type publishedEvent struct {
	Type    string
	Message string
	Data    map[string]any
}

func truncateMessage(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= maxPublishedMessage {
		return value
	}
	return value[:maxPublishedMessage] + "… (truncated)"
}

// iterCursorJSONObjects splits a stdout line that may contain multiple
// concatenated stream-json objects (Cursor sometimes emits `}{` without
// newlines). A single non-JSON prefix returns the original line for verbatim
// forwarding.
func iterCursorJSONObjects(line string) []string {
	s := strings.TrimSpace(line)
	if s == "" {
		return nil
	}
	var objects []string
	for len(s) > 0 {
		s = strings.TrimLeft(s, " \t")
		if len(s) == 0 {
			break
		}
		if !strings.HasPrefix(s, "{") {
			return []string{line}
		}
		dec := json.NewDecoder(strings.NewReader(s))
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return []string{line}
		}
		objects = append(objects, string(raw))
		s = s[dec.InputOffset():]
	}
	if len(objects) == 0 {
		return []string{line}
	}
	return objects
}

func isToolCallMetadataKey(key string) bool {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "toolcallid", "id", "callid", "requestid", "tooluseid", "tool_use_id":
		return true
	default:
		return false
	}
}

func nestedToolFromToolCall(raw json.RawMessage) (name string, detail string) {
	if len(raw) == 0 {
		return "", ""
	}
	var outer map[string]json.RawMessage
	if json.Unmarshal(raw, &outer) != nil {
		return "", ""
	}
	keys := make([]string, 0, len(outer))
	for key := range outer {
		if isToolCallMetadataKey(key) {
			continue
		}
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		iTool := strings.HasSuffix(keys[i], "ToolCall")
		jTool := strings.HasSuffix(keys[j], "ToolCall")
		if iTool != jTool {
			return iTool
		}
		return len(keys[i]) > len(keys[j])
	})
	for _, key := range keys {
		innerRaw := outer[key]
		label := strings.TrimSuffix(key, "ToolCall")
		if label == "" {
			label = key
		}
		var inner map[string]json.RawMessage
		if json.Unmarshal(innerRaw, &inner) != nil {
			continue
		}
		if args, ok := inner["args"]; ok {
			return label, toolDetail(args)
		}
		if len(inner) > 0 {
			return label, ""
		}
	}
	return "", ""
}

// parseCursorEvent decodes a stream-json line. ok is false for non-JSON lines
// (progress bars, stderr noise) which callers should forward verbatim.
func parseCursorEvent(line string) (cursorStreamEvent, bool) {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "{") {
		return cursorStreamEvent{}, false
	}
	var evt cursorStreamEvent
	if json.Unmarshal([]byte(trimmed), &evt) != nil {
		return cursorStreamEvent{}, false
	}
	if evt.Type == "" {
		return cursorStreamEvent{}, false
	}
	return evt, true
}

func (e cursorStreamEvent) contentParts() []cursorContentPart {
	if len(e.Message) == 0 {
		return nil
	}
	var msg cursorMessage
	if json.Unmarshal(e.Message, &msg) != nil {
		return nil
	}
	if len(msg.Content) == 0 {
		return nil
	}
	// content is either a plain string or an array of typed blocks.
	var text string
	if json.Unmarshal(msg.Content, &text) == nil {
		if strings.TrimSpace(text) == "" {
			return nil
		}
		return []cursorContentPart{{Type: "text", Text: text}}
	}
	var parts []cursorContentPart
	if json.Unmarshal(msg.Content, &parts) != nil {
		return nil
	}
	return parts
}

func (e cursorStreamEvent) toolLabel() string {
	for _, candidate := range []string{e.ToolName, e.Tool, e.Name} {
		if strings.TrimSpace(candidate) != "" {
			return strings.TrimSpace(candidate)
		}
	}
	for _, part := range e.contentParts() {
		if part.Type == "tool_use" && strings.TrimSpace(part.Name) != "" {
			return strings.TrimSpace(part.Name)
		}
	}
	return ""
}

// toolDetail pulls the most useful identifier out of a tool input payload so the
// activity feed shows "Read src/app/page.tsx" instead of a bare tool name.
func toolDetail(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var fields map[string]any
	if json.Unmarshal(raw, &fields) != nil {
		return ""
	}
	for _, key := range []string{
		"command", "path", "file_path", "filePath", "target_file",
		"pattern", "query", "url",
	} {
		if value, ok := fields[key]; ok {
			if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
				return truncateMessage(text)
			}
		}
	}
	return ""
}

func (e cursorStreamEvent) toolInput() json.RawMessage {
	if len(e.Input) > 0 {
		return e.Input
	}
	for _, part := range e.contentParts() {
		if part.Type == "tool_use" && len(part.Input) > 0 {
			return part.Input
		}
	}
	return nil
}

func toolCallID(evt cursorStreamEvent) string {
	if len(evt.ToolCall) == 0 {
		return ""
	}
	var nested map[string]any
	if json.Unmarshal(evt.ToolCall, &nested) != nil {
		return ""
	}
	for _, key := range []string{"toolCallId", "tool_call_id", "id"} {
		if value, ok := nested[key]; ok {
			if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
				return strings.TrimSpace(text)
			}
		}
	}
	return ""
}

func isShellToolLabel(label string) bool {
	switch strings.ToLower(strings.TrimSpace(label)) {
	case "bash", "shell", "awaitshell", "run_terminal_cmd", "run_terminal_command", "terminal":
		return true
	default:
		return false
	}
}

// summarizeCursorEvent converts a parsed stream event into readable events.
// Returning an empty slice means the event carries no user-facing information.
func summarizeCursorEvent(evt cursorStreamEvent) []publishedEvent {
	switch evt.Type {
	case "thinking", "assistant_delta":
		// Token-level thinking/delta lines flood the UI; assistant text is
		// published on completed assistant/message events instead.
		return nil

	case "assistant", "message":
		var out []publishedEvent
		for _, part := range evt.contentParts() {
			switch part.Type {
			case "text", "":
				if text := truncateMessage(part.Text); text != "" {
					out = append(out, publishedEvent{
						Type:    "agent.output",
						Message: text,
						Data:    map[string]any{"stream": "assistant"},
					})
				}
			case "tool_use":
				out = append(out, toolEvent(part.Name, toolDetail(part.Input)))
			}
		}
		return out

	case "connection":
		sub := strings.TrimSpace(evt.Subtype)
		if sub == "reconnecting" {
			return []publishedEvent{{
				Type:    "agent.output",
				Message: "connection: reconnecting",
				Data:    map[string]any{"stream": "status"},
			}}
		}
		return nil

	case "retry":
		if strings.TrimSpace(evt.Subtype) == "starting" {
			return []publishedEvent{{
				Type:    "agent.output",
				Message: "retrying cursor agent session",
				Data:    map[string]any{"stream": "status"},
			}}
		}
		return nil

	case "tool_call", "tool_use":
		if evt.Subtype == "completed" {
			return nil
		}
		label := evt.toolLabel()
		detail := toolDetail(evt.toolInput())
		if label == "" || label == "tool" {
			n, d := nestedToolFromToolCall(evt.ToolCall)
			if n != "" {
				label = n
				if d != "" {
					detail = d
				}
			}
		}
		return []publishedEvent{toolEvent(label, detail)}

	case "result":
		message := truncateMessage(evt.Result)
		if message == "" {
			message = "cursor agent finished"
		}
		stream := "assistant"
		if evt.IsError {
			stream = "stderr"
		}
		return []publishedEvent{{
			Type:    "agent.output",
			Message: message,
			Data:    map[string]any{"durationMs": evt.Duration, "stream": stream},
		}}
	}

	// Unrecognized event types must still surface something. Silently discarding
	// stream lines is what made runs look frozen, so fall back to the raw type.
	if _, quiet := quietStreamTypes[evt.Type]; quiet {
		return nil
	}
	if text := truncateMessage(evt.textFallback()); text != "" {
		return []publishedEvent{{
			Type:    "agent.output",
			Message: text,
			Data:    map[string]any{"stream": "assistant", "eventType": evt.Type},
		}}
	}
	return nil
}

// quietStreamTypes carry no user-facing content and would only add noise.
var quietStreamTypes = map[string]struct{}{
	"system":     {},
	"user":       {},
	"connection": {},
	"retry":      {},
}

// textFallback collects any readable text from an event whose shape we do not
// model explicitly, so schema changes in the CLI degrade instead of going silent.
func (e cursorStreamEvent) textFallback() string {
	parts := make([]string, 0, 4)
	for _, part := range e.contentParts() {
		if text := strings.TrimSpace(part.Text); text != "" {
			parts = append(parts, text)
		}
	}
	if len(parts) > 0 {
		return strings.Join(parts, " ")
	}
	if subtype := strings.TrimSpace(e.Subtype); subtype != "" {
		return e.Type + ": " + subtype
	}
	return e.Type
}

func toolEvent(name, detail string) publishedEvent {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "tool"
	}
	message := name
	if detail != "" {
		message = fmt.Sprintf("%s %s", name, detail)
	}
	data := map[string]any{"tool": name}
	if detail != "" {
		data["detail"] = detail
	}
	return publishedEvent{Type: "agent.tool", Message: message, Data: data}
}
