package tree_sitter_metta_test

import (
	"testing"

	tree_sitter "github.com/smacker/go-tree-sitter"
	"github.com/tree-sitter/tree-sitter-metta"
)

func TestCanLoadGrammar(t *testing.T) {
	language := tree_sitter.NewLanguage(tree_sitter_metta.Language())
	if language == nil {
		t.Errorf("Error loading Metta grammar")
	}
}
