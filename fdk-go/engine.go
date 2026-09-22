package bridge

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
	"unsafe"
)

const (
	ABIVersion = 1

	StatusNone    = 0
	StatusOK      = 1
	StatusPartial = 2
	StatusError   = 3

	StatusUnchanged     = StatusNone
	StatusFullUpdate    = StatusOK
	StatusPartialUpdate = StatusPartial

	fieldFlagCritical = 1

	tagSource           = 1
	tagFilename         = 2
	tagInlineConfig     = 3
	tagRegisteredConfig = 4
	tagRanges           = 5
)

var requestMagic = []byte("WASM-FMT")

// TextRange is a half-open range of UTF-8 byte offsets in the original source.
type TextRange struct {
	Start uint32
	End   uint32
}

// TextEdit replaces Range in the original source with Text.
type TextEdit struct {
	Range TextRange
	Text  string
}

type formatResultKind uint8

const (
	resultUnchanged formatResultKind = iota
	resultFullUpdate
	resultPartialUpdate
	resultError
)

// FormatResult is the result returned by a formatter.
//
// Construct results with Unchanged, FullUpdate, PartialUpdate, FormatError, or
// FromBytes.
type FormatResult struct {
	kind   formatResultKind
	output []byte
	edits  []TextEdit
	err    error
}

// Unchanged reports that the original source should be returned as-is.
func Unchanged() FormatResult {
	return FormatResult{kind: resultUnchanged}
}

// FullUpdate reports a complete replacement for the source.
func FullUpdate(output []byte) FormatResult {
	return FormatResult{kind: resultFullUpdate, output: output}
}

// PartialUpdate reports ordered, non-overlapping edits against the original
// source. An empty edit list is a valid partial update.
func PartialUpdate(edits []TextEdit) FormatResult {
	return FormatResult{kind: resultPartialUpdate, edits: edits}
}

// FormatError reports a formatter error.
func FormatError(err error) FormatResult {
	if err == nil {
		err = errors.New("formatter returned a nil error")
	}
	return FormatResult{kind: resultError, err: err}
}

// FromBytes converts the conventional formatted-bytes-and-error result into a
// FormatResult. Successful output always produces a FullUpdate; callers must
// return Unchanged explicitly when that distinction matters.
func FromBytes(output []byte, err error) FormatResult {
	if err != nil {
		return FormatError(err)
	}
	return FullUpdate(output)
}

type Formatter interface {
	Format(source []byte, filename *string) FormatResult
}

// RangeFormatter supports both whole-file and range formatting. Ranges are
// half-open UTF-8 byte ranges in source. A nil slice means the request omitted
// ranges; a non-nil empty slice means it explicitly requested zero ranges.
type RangeFormatter interface {
	Format(source []byte, filename *string, ranges []TextRange) FormatResult
}

type ConfigFormatter[C any] interface {
	DecodeConfig(config []byte) (C, error)
	DefaultConfig() C
	Format(source []byte, filename *string, config C) FormatResult
}

// ConfigRangeFormatter supports configuration and range formatting.
type ConfigRangeFormatter[C any] interface {
	DecodeConfig(config []byte) (C, error)
	DefaultConfig() C
	Format(source []byte, filename *string, ranges []TextRange, config C) FormatResult
}

type engineFormatter[C any] interface {
	supportsConfig() bool
	supportsRanges() bool
	decodeConfig(config []byte) (C, error)
	defaultConfig() C
	format(source []byte, filename *string, ranges []TextRange, config C) FormatResult
}

// NoConfig is the engine state used by formatters without configuration support.
type NoConfig struct{}

type formatterAdapter struct {
	formatter Formatter
}

func (a formatterAdapter) supportsConfig() bool {
	return false
}

func (a formatterAdapter) supportsRanges() bool {
	return false
}

func (a formatterAdapter) decodeConfig([]byte) (NoConfig, error) {
	return NoConfig{}, errors.New("formatter does not support configuration")
}

func (a formatterAdapter) defaultConfig() NoConfig {
	return NoConfig{}
}

func (a formatterAdapter) format(
	source []byte,
	filename *string,
	_ []TextRange,
	_ NoConfig,
) FormatResult {
	return a.formatter.Format(source, filename)
}

type rangeFormatterAdapter struct {
	formatter RangeFormatter
}

func (a rangeFormatterAdapter) supportsConfig() bool {
	return false
}

func (a rangeFormatterAdapter) supportsRanges() bool {
	return true
}

func (a rangeFormatterAdapter) decodeConfig([]byte) (NoConfig, error) {
	return NoConfig{}, errors.New("formatter does not support configuration")
}

func (a rangeFormatterAdapter) defaultConfig() NoConfig {
	return NoConfig{}
}

func (a rangeFormatterAdapter) format(
	source []byte,
	filename *string,
	ranges []TextRange,
	_ NoConfig,
) FormatResult {
	return a.formatter.Format(source, filename, ranges)
}

type configFormatterAdapter[C any] struct {
	formatter ConfigFormatter[C]
}

func (a configFormatterAdapter[C]) supportsConfig() bool {
	return true
}

func (a configFormatterAdapter[C]) supportsRanges() bool {
	return false
}

func (a configFormatterAdapter[C]) decodeConfig(config []byte) (C, error) {
	return a.formatter.DecodeConfig(config)
}

func (a configFormatterAdapter[C]) defaultConfig() C {
	return a.formatter.DefaultConfig()
}

func (a configFormatterAdapter[C]) format(
	source []byte,
	filename *string,
	_ []TextRange,
	config C,
) FormatResult {
	return a.formatter.Format(source, filename, config)
}

type configRangeFormatterAdapter[C any] struct {
	formatter ConfigRangeFormatter[C]
}

func (a configRangeFormatterAdapter[C]) supportsConfig() bool {
	return true
}

func (a configRangeFormatterAdapter[C]) supportsRanges() bool {
	return true
}

func (a configRangeFormatterAdapter[C]) decodeConfig(config []byte) (C, error) {
	return a.formatter.DecodeConfig(config)
}

func (a configRangeFormatterAdapter[C]) defaultConfig() C {
	return a.formatter.DefaultConfig()
}

func (a configRangeFormatterAdapter[C]) format(
	source []byte,
	filename *string,
	ranges []TextRange,
	config C,
) FormatResult {
	return a.formatter.Format(source, filename, ranges, config)
}

type Engine[C any] struct {
	formatter        engineFormatter[C]
	input            []byte
	outputByteString []byte
	errorByteString  []byte
	registeredConfig map[uint32]C
}

type formatRequest[C any] struct {
	source   []byte
	filename *string
	ranges   []TextRange
	config   C
}

func NewEngine(formatter Formatter) *Engine[NoConfig] {
	return &Engine[NoConfig]{
		formatter:        formatterAdapter{formatter: formatter},
		registeredConfig: make(map[uint32]NoConfig),
	}
}

func NewRangeEngine(formatter RangeFormatter) *Engine[NoConfig] {
	return &Engine[NoConfig]{
		formatter:        rangeFormatterAdapter{formatter: formatter},
		registeredConfig: make(map[uint32]NoConfig),
	}
}

func NewConfigEngine[C any](formatter ConfigFormatter[C]) *Engine[C] {
	return &Engine[C]{
		formatter:        configFormatterAdapter[C]{formatter: formatter},
		registeredConfig: make(map[uint32]C),
	}
}

func NewConfigRangeEngine[C any](formatter ConfigRangeFormatter[C]) *Engine[C] {
	return &Engine[C]{
		formatter:        configRangeFormatterAdapter[C]{formatter: formatter},
		registeredConfig: make(map[uint32]C),
	}
}

func (e *Engine[C]) Alloc(size uint32) uint32 {
	e.input = make([]byte, size)
	if size == 0 {
		return 0
	}
	return uint32(uintptr(unsafe.Pointer(&e.input[0])))
}

func (e *Engine[C]) Reset() {
	e.input = nil
	e.outputByteString = nil
	e.errorByteString = nil
}

func (e *Engine[C]) RegisterConfig(id uint32, ptr uint32, length uint32) uint32 {
	e.clearResult()

	if !e.formatter.supportsConfig() {
		e.setError(errors.New("formatter does not support configuration"))
		return StatusError
	}
	if id == 0 {
		e.setError(errors.New("config id 0 is reserved"))
		return StatusError
	}

	if _, exists := e.registeredConfig[id]; exists {
		e.setError(fmt.Errorf("registered_config id %d is already live", id))
		return StatusError
	}

	configBytes := bytes.Clone(e.inputBytes(ptr, length))
	config, err := e.formatter.decodeConfig(configBytes)
	if err != nil {
		e.setError(err)
		return StatusError
	}

	e.registeredConfig[id] = config
	return StatusOK
}

func (e *Engine[C]) ReleaseConfig(id uint32) {
	delete(e.registeredConfig, id)
}

func (e *Engine[C]) Format(ptr uint32, length uint32) uint32 {
	return e.formatBytes(e.inputBytes(ptr, length))
}

func (e *Engine[C]) formatBytes(request []byte) uint32 {
	e.clearResult()

	req, err := e.parseRequest(request)
	if err != nil {
		e.setError(err)
		return StatusError
	}

	formatterSource := bytes.Clone(req.source)
	result := e.formatter.format(formatterSource, req.filename, req.ranges, req.config)
	status, output, err := resolveFormatResult(req.source, result)
	if err != nil {
		e.setError(err)
		return StatusError
	}
	if status == StatusUnchanged {
		return status
	}

	if err := e.setOutput(output); err != nil {
		e.setError(err)
		return StatusError
	}
	return status
}

func resolveFormatResult(source []byte, result FormatResult) (uint32, []byte, error) {
	switch result.kind {
	case resultUnchanged:
		return StatusUnchanged, nil, nil
	case resultFullUpdate:
		if !utf8.Valid(result.output) {
			return StatusError, nil, errors.New("full update output must be valid UTF-8")
		}
		if uint64(len(result.output)) > maxByteStringPayloadSize() {
			return StatusError, nil, errors.New("full update output is too large")
		}
		return StatusFullUpdate, result.output, nil
	case resultPartialUpdate:
		output, err := encodePartialUpdate(source, result.edits)
		if err != nil {
			return StatusError, nil, err
		}
		return StatusPartialUpdate, output, nil
	case resultError:
		if result.err == nil {
			return StatusError, nil, errors.New("formatter returned a nil error")
		}
		return StatusError, nil, result.err
	default:
		return StatusError, nil, errors.New("formatter returned an invalid result")
	}
}

func (e *Engine[C]) Output() uint32 {
	return byteStringPtr(e.outputByteString)
}

func (e *Engine[C]) Error() uint32 {
	return byteStringPtr(e.errorByteString)
}

func (e *Engine[C]) parseRequest(req []byte) (formatRequest[C], error) {
	var result formatRequest[C]

	if len(req) < len(requestMagic) || !bytes.Equal(req[:len(requestMagic)], requestMagic) {
		return result, errors.New("request magic must be WASM-FMT")
	}

	offset := len(requestMagic)
	var sourceSet, filenameSet, inlineConfigSet, registeredConfigSet, rangesSet bool
	var inlineConfig []byte
	var registeredConfigID uint32

	for offset < len(req) {
		if len(req)-offset < 8 {
			return result, errors.New("truncated TLV field header")
		}

		tag := binary.LittleEndian.Uint16(req[offset:])
		fieldFlags := binary.LittleEndian.Uint16(req[offset+2:])
		fieldLen := binary.LittleEndian.Uint32(req[offset+4:])
		offset += 8

		if fieldFlags&^fieldFlagCritical != 0 {
			return result, fmt.Errorf("field %d has unsupported flags", tag)
		}
		if uint32(len(req)-offset) < fieldLen {
			return result, fmt.Errorf("field %d extends past request length", tag)
		}

		valueEnd := offset + int(fieldLen)
		value := req[offset:valueEnd:valueEnd]
		offset = valueEnd

		switch tag {
		case tagSource:
			if sourceSet {
				return result, errors.New("duplicate source field")
			}
			result.source = value
			sourceSet = true
		case tagFilename:
			if filenameSet {
				return result, errors.New("duplicate filename field")
			}
			filename := string(value)
			result.filename = &filename
			filenameSet = true
		case tagInlineConfig:
			if inlineConfigSet {
				return result, errors.New("duplicate inline_config field")
			}
			inlineConfig = bytes.Clone(value)
			inlineConfigSet = true
		case tagRegisteredConfig:
			if registeredConfigSet {
				return result, errors.New("duplicate registered_config field")
			}
			if len(value) != 4 {
				return result, errors.New("registered_config field must be a u32")
			}
			registeredConfigID = binary.LittleEndian.Uint32(value)
			registeredConfigSet = true
		case tagRanges:
			if rangesSet {
				return result, errors.New("duplicate ranges field")
			}
			if fieldFlags != 0 {
				return result, errors.New("ranges field flags must be 0")
			}
			ranges, err := decodeRanges(value)
			if err != nil {
				return result, err
			}
			result.ranges = ranges
			rangesSet = true
		default:
			if fieldFlags&fieldFlagCritical != 0 {
				return result, fmt.Errorf("unknown critical field %d", tag)
			}
		}
	}

	if !sourceSet {
		return result, errors.New("missing source field")
	}
	if !utf8.Valid(result.source) {
		return result, errors.New("source must be valid UTF-8")
	}
	if filenameSet && !utf8.ValidString(*result.filename) {
		return result, errors.New("filename must be valid UTF-8")
	}
	if inlineConfigSet && registeredConfigSet {
		return result, errors.New("inline_config and registered_config are mutually exclusive")
	}
	if (inlineConfigSet || registeredConfigSet) && !e.formatter.supportsConfig() {
		return result, errors.New("formatter does not support configuration")
	}
	if rangesSet && !e.formatter.supportsRanges() {
		return result, errors.New("formatter does not support range formatting")
	}
	if rangesSet {
		if err := validateRanges(result.source, result.ranges); err != nil {
			return result, err
		}
	}

	if inlineConfigSet {
		config, err := e.formatter.decodeConfig(inlineConfig)
		if err != nil {
			return result, err
		}
		result.config = config
	} else if registeredConfigSet {
		if registeredConfigID == 0 {
			return result, errors.New("registered_config id 0 is reserved")
		}
		config, ok := e.registeredConfig[registeredConfigID]
		if !ok {
			return result, fmt.Errorf("registered_config id %d was not found", registeredConfigID)
		}
		result.config = config
	} else {
		result.config = e.formatter.defaultConfig()
	}

	return result, nil
}

func decodeRanges(value []byte) ([]TextRange, error) {
	const headerSize = 4
	const recordSize = 8

	if len(value) < headerSize {
		return nil, errors.New("ranges field is truncated")
	}

	count := binary.LittleEndian.Uint32(value)
	recordsLength := uint64(len(value) - headerSize)
	expectedLength := uint64(count) * recordSize
	if recordsLength != expectedLength {
		return nil, errors.New("ranges field length does not match its range count")
	}

	ranges := make([]TextRange, int(count))
	offset := headerSize
	for index := range ranges {
		ranges[index] = TextRange{
			Start: binary.LittleEndian.Uint32(value[offset:]),
			End:   binary.LittleEndian.Uint32(value[offset+4:]),
		}
		offset += recordSize
	}
	return ranges, nil
}

func validateRanges(source []byte, ranges []TextRange) error {
	for index, textRange := range ranges {
		if textRange.Start > textRange.End {
			return fmt.Errorf("range %d has start after end", index)
		}
		if uint64(textRange.End) > uint64(len(source)) {
			return fmt.Errorf("range %d extends past source length", index)
		}
		if !isUTF8Boundary(source, textRange.Start) || !isUTF8Boundary(source, textRange.End) {
			return fmt.Errorf("range %d is not on UTF-8 boundaries", index)
		}
	}
	return nil
}

func (e *Engine[C]) inputBytes(ptr uint32, length uint32) []byte {
	if e.input == nil {
		panic("input transaction requires an allocation")
	}
	var expected uint32
	if len(e.input) != 0 {
		expected = uint32(uintptr(unsafe.Pointer(&e.input[0])))
	}
	if ptr != expected || uint64(length) != uint64(len(e.input)) {
		panic("request must use the complete current input allocation")
	}
	input := e.input
	e.input = nil
	return input
}

func (e *Engine[C]) clearResult() {
	e.outputByteString = nil
	e.errorByteString = nil
}

func (e *Engine[C]) setOutput(payload []byte) error {
	byteString, err := makeByteString(payload)
	if err != nil {
		e.outputByteString = nil
		e.errorByteString = nil
		return err
	}

	e.outputByteString = byteString
	e.errorByteString = nil
	return nil
}

func (e *Engine[C]) setError(err error) {
	e.outputByteString = nil
	payload := normalizedErrorPayload(err)
	byteString, makeErr := makeByteString(payload)
	if makeErr != nil {
		byteString, _ = makeByteString([]byte("formatter error"))
	}
	e.errorByteString = byteString
}

func encodePartialUpdate(source []byte, edits []TextEdit) ([]byte, error) {
	const recordHeaderSize = uint64(12)
	const maxUint32 = uint64(^uint32(0))

	if !utf8.Valid(source) {
		return nil, errors.New("partial update source must be valid UTF-8")
	}
	if uint64(len(source)) > maxUint32 {
		return nil, errors.New("partial update source is too large")
	}
	if uint64(len(edits)) > maxUint32 {
		return nil, errors.New("partial update has too many edits")
	}

	totalSize := uint64(4)
	cursor := uint32(0)
	for index, edit := range edits {
		start := edit.Range.Start
		end := edit.Range.End

		if start > end {
			return nil, fmt.Errorf("partial update edit %d has start after end", index)
		}
		if uint64(end) > uint64(len(source)) {
			return nil, fmt.Errorf("partial update edit %d extends past source length", index)
		}
		if start < cursor {
			return nil, fmt.Errorf("partial update edit %d is out of order or overlaps a previous edit", index)
		}
		if !isUTF8Boundary(source, start) || !isUTF8Boundary(source, end) {
			return nil, fmt.Errorf("partial update edit %d range is not on UTF-8 boundaries", index)
		}
		if !utf8.ValidString(edit.Text) {
			return nil, fmt.Errorf("partial update edit %d text must be valid UTF-8", index)
		}

		textLength := uint64(len(edit.Text))
		if textLength > maxUint32 {
			return nil, fmt.Errorf("partial update edit %d text is too large", index)
		}
		recordSize := recordHeaderSize + textLength
		if recordSize > maxUint32-totalSize {
			return nil, errors.New("partial update payload is too large")
		}

		totalSize += recordSize
		cursor = end
	}

	if totalSize > maxByteStringPayloadSize() {
		return nil, errors.New("partial update payload is too large for this platform")
	}

	output := make([]byte, int(totalSize))
	binary.LittleEndian.PutUint32(output, uint32(len(edits)))

	offset := 4
	for _, edit := range edits {
		textLength := len(edit.Text)
		binary.LittleEndian.PutUint32(output[offset:], edit.Range.Start)
		binary.LittleEndian.PutUint32(output[offset+4:], edit.Range.End)
		binary.LittleEndian.PutUint32(output[offset+8:], uint32(textLength))
		offset += int(recordHeaderSize)
		copy(output[offset:], edit.Text)
		offset += textLength
	}

	return output, nil
}

func isUTF8Boundary(source []byte, offset uint32) bool {
	if offset == 0 || uint64(offset) == uint64(len(source)) {
		return true
	}
	return utf8.RuneStart(source[int(offset)])
}

func maxByteStringPayloadSize() uint64 {
	const byteStringHeaderSize = uint64(4)
	const maxUint32 = uint64(^uint32(0))

	maxInt := uint64(^uint(0) >> 1)
	if maxInt <= byteStringHeaderSize {
		return 0
	}

	maxPayload := maxInt - byteStringHeaderSize
	if maxPayload < maxUint32 {
		return maxPayload
	}
	return maxUint32
}

func makeByteString(payload []byte) ([]byte, error) {
	allocationSize, err := byteStringAllocationSize(uint64(len(payload)))
	if err != nil {
		return nil, err
	}

	buf := make([]byte, allocationSize)
	binary.LittleEndian.PutUint32(buf, uint32(len(payload)))
	copy(buf[4:], payload)
	return buf, nil
}

func byteStringAllocationSize(payloadSize uint64) (int, error) {
	const byteStringHeaderSize = uint64(4)

	if payloadSize > maxByteStringPayloadSize() {
		return 0, errors.New("ByteString payload is too large")
	}

	allocationSize := payloadSize + byteStringHeaderSize
	return int(allocationSize), nil
}

func normalizedErrorPayload(err error) []byte {
	const replacement = "\uFFFD"
	const fallback = "formatter error message is too large"

	message := "unknown formatter error"
	if err != nil {
		message = err.Error()
	}

	maxPayloadSize := maxByteStringPayloadSize()
	if utf8.ValidString(message) {
		if uint64(len(message)) > maxPayloadSize {
			return []byte(fallback)
		}
		return []byte(message)
	}

	if !normalizedUTF8Fits(message, maxPayloadSize) {
		return []byte(fallback)
	}

	normalized := strings.ToValidUTF8(message, replacement)
	if uint64(len(normalized)) > maxPayloadSize {
		return []byte(fallback)
	}
	return []byte(normalized)
}

func normalizedUTF8Fits(value string, limit uint64) bool {
	var size uint64

	for len(value) > 0 {
		r, width := utf8.DecodeRuneInString(value)
		increment := uint64(width)
		if r == utf8.RuneError && width == 1 {
			increment = uint64(utf8.RuneLen(utf8.RuneError))
		}
		if increment > limit-size {
			return false
		}

		size += increment
		value = value[width:]
	}

	return true
}

func byteStringPtr(buf []byte) uint32 {
	if len(buf) == 0 {
		return 0
	}
	return uint32(uintptr(unsafe.Pointer(&buf[0])))
}
