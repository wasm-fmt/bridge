package bridge

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"
	"unicode/utf8"
)

type testConfig struct{}

type mutatingConfigFormatter struct{}

func (mutatingConfigFormatter) DecodeConfig(config []byte) (testConfig, error) {
	for index := range config {
		config[index] = 'x'
	}
	if cap(config) > len(config) {
		expanded := config[:cap(config)]
		for index := len(config); index < len(expanded); index++ {
			expanded[index] = 'x'
		}
	}
	return testConfig{}, nil
}

func (mutatingConfigFormatter) DefaultConfig() testConfig {
	return testConfig{}
}

func (mutatingConfigFormatter) Format(
	source []byte,
	path *string,
	config testConfig,
) FormatResult {
	return Unchanged()
}

type noConfigFormatter struct{}

func (noConfigFormatter) Format(source []byte, filename *string) FormatResult {
	return Unchanged()
}

type fixedResultFormatter struct {
	result FormatResult
}

func (formatter fixedResultFormatter) Format(source []byte, filename *string) FormatResult {
	return formatter.result
}

type mutatingPartialFormatter struct{}

func (mutatingPartialFormatter) Format(source []byte, filename *string) FormatResult {
	copy(source, "ab")
	return PartialUpdate([]TextEdit{
		{Range: TextRange{Start: 1, End: 2}, Text: "x"},
	})
}

type tlvField struct {
	tag   uint16
	flags uint16
	value []byte
}

func makeRequest(fields ...tlvField) []byte {
	var buffer bytes.Buffer
	buffer.Write(requestMagic)

	for _, field := range fields {
		var header [8]byte
		binary.LittleEndian.PutUint16(header[0:], field.tag)
		binary.LittleEndian.PutUint16(header[2:], field.flags)
		binary.LittleEndian.PutUint32(header[4:], uint32(len(field.value)))
		buffer.Write(header[:])
		buffer.Write(field.value)
	}

	return buffer.Bytes()
}

func TestInlineConfigDecoderCannotMutateRequestFields(t *testing.T) {
	engine := NewConfigEngine[testConfig](mutatingConfigFormatter{})
	request := makeRequest(
		tlvField{tag: tagInlineConfig, value: []byte("config")},
		tlvField{tag: tagSource, value: []byte("source")},
	)
	originalRequest := bytes.Clone(request)

	parsed, err := engine.parseRequest(request)
	if err != nil {
		t.Fatalf("parse request: %v", err)
	}
	if string(parsed.source) != "source" {
		t.Fatalf("unexpected source: %q", parsed.source)
	}
	if !bytes.Equal(request, originalRequest) {
		t.Fatal("config decoder mutated the request buffer")
	}
}

func TestNoConfigFormatterRejectsConfiguration(t *testing.T) {
	engine := NewEngine(noConfigFormatter{})
	request := makeRequest(
		tlvField{tag: tagSource, value: []byte("source")},
		tlvField{tag: tagInlineConfig},
	)

	if _, err := engine.parseRequest(request); err == nil {
		t.Fatal("expected inline config to be rejected")
	}
	if status := engine.RegisterConfig(1, 0, 0); status != StatusError {
		t.Fatalf("unexpected register status: %d", status)
	}
}

func TestEncodePartialUpdateUsesThePublicWireFormat(t *testing.T) {
	payload, err := encodePartialUpdate([]byte("a"), []TextEdit{
		{Range: TextRange{Start: 0, End: 1}, Text: "X"},
	})
	if err != nil {
		t.Fatalf("encode partial update: %v", err)
	}

	expected := []byte{
		1, 0, 0, 0,
		0, 0, 0, 0,
		1, 0, 0, 0,
		1, 0, 0, 0,
		'X',
	}
	if !bytes.Equal(payload, expected) {
		t.Fatalf("unexpected payload: got %v, want %v", payload, expected)
	}
}

func TestEncodePartialUpdateRejectsStructurallyInvalidEdits(t *testing.T) {
	cases := []struct {
		source []byte
		edits  []TextEdit
	}{
		{source: []byte{0xff}},
		{source: []byte("abc"), edits: []TextEdit{{Range: TextRange{Start: 2, End: 1}}}},
		{source: []byte("abc"), edits: []TextEdit{{Range: TextRange{Start: 0, End: 4}}}},
		{source: []byte("é"), edits: []TextEdit{{Range: TextRange{Start: 1, End: 2}}}},
		{source: []byte("abc"), edits: []TextEdit{
			{Range: TextRange{Start: 0, End: 2}},
			{Range: TextRange{Start: 1, End: 3}},
		}},
		{source: []byte("abc"), edits: []TextEdit{{
			Range: TextRange{Start: 0, End: 0},
			Text:  string([]byte{0xff}),
		}}},
	}

	for index, test := range cases {
		if _, err := encodePartialUpdate(test.source, test.edits); err == nil {
			t.Fatalf("case %d: expected invalid partial update to fail", index)
		}
	}
}

func TestEngineRejectsInvalidFullUpdateUTF8(t *testing.T) {
	engine := NewEngine(fixedResultFormatter{result: FullUpdate([]byte{0xff})})
	request := makeRequest(tlvField{tag: tagSource, value: []byte("source")})

	if status := engine.formatBytes(request); status != StatusError {
		t.Fatalf("unexpected status: %d", status)
	}
	if engine.outputByteString != nil {
		t.Fatalf("unexpected output: %v", engine.outputByteString)
	}
	if !utf8.Valid(engine.errorByteString[4:]) {
		t.Fatalf("error payload is not valid UTF-8: %v", engine.errorByteString[4:])
	}
}

func TestFormatterMutationCannotChangePartialValidationSource(t *testing.T) {
	engine := NewEngine(mutatingPartialFormatter{})
	request := makeRequest(tlvField{tag: tagSource, value: []byte("é")})
	originalRequest := bytes.Clone(request)

	if status := engine.formatBytes(request); status != StatusError {
		t.Fatalf("unexpected status: %d", status)
	}
	if !bytes.Equal(request, originalRequest) {
		t.Fatal("formatter mutated the request source")
	}
}

func TestByteStringCapacityIsChecked(t *testing.T) {
	byteString, err := makeByteString([]byte("formatted"))
	if err != nil {
		t.Fatalf("make ByteString: %v", err)
	}
	expected := append([]byte{9, 0, 0, 0}, []byte("formatted")...)
	if !bytes.Equal(byteString, expected) {
		t.Fatalf("unexpected ByteString: %v", byteString)
	}

	if _, err := byteStringAllocationSize(maxByteStringPayloadSize() + 1); err == nil {
		t.Fatal("expected oversized payload to fail")
	}
}

func TestErrorByteStringIsValidUTF8AndAccountsForReplacementSize(t *testing.T) {
	engine := NewEngine(noConfigFormatter{})
	message := string([]byte{'a', 0xff, 0xfe, 'b'})
	engine.setError(errors.New(message))

	if !utf8.Valid(engine.errorByteString[4:]) {
		t.Fatalf("error payload is not valid UTF-8: %v", engine.errorByteString[4:])
	}
	if normalizedUTF8Fits(string([]byte{0xff}), 2) {
		t.Fatal("replacement should not fit in two bytes")
	}
	if !normalizedUTF8Fits(string([]byte{0xff}), 3) {
		t.Fatal("replacement should fit in three bytes")
	}
}
