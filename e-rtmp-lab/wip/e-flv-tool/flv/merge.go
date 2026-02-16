package flv

import "fmt"

// MergeFLV merges two FLV/E-FLV files into a single output file.
func MergeFLV(inputA, inputB, outputPath string, multitrack bool) error {
	fmt.Printf("TODO: merge FLV files: %s + %s -> %s\n", inputA, inputB, outputPath)
	if multitrack {
		fmt.Println("  (multitrack mode requested)")
	}

	// TODO: Open and validate both input FLV files
	// TODO: Parse headers and tags from both inputs
	// TODO: If multitrack, assign separate track groups per input
	// TODO: Interleave tags by timestamp
	// TODO: Write valid FLV header and merged tags to output
	// TODO: Ensure output is a valid .flv file

	return nil
}
