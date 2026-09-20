Feature: Dogfooding archstrict against nukadoko's real source

  nukadoko's src/ has no public-surface convention of its own (no module
  directory was built with archstrict in mind), so every module in it starts
  entirely private under archstrict's default posture. This checks that
  posture against real files instead of a synthetic fixture, and checks the
  full init -> check -> todo -> edit -> check round trip end to end. The
  round trip is only green once every in-scope file is either covered by a
  declared module or excluded - init cannot decide that on a project's
  behalf, so this scenario makes that same call nukadoko's own loose root
  files force a real project owner to make.

  Scenario: every nukadoko module is private by default, and freezing it is green
    Given the nukadoko package's own published src exists as a scratch copy
    When archstrict init runs against the scratch copy
    And archstrict check runs against the scratch copy
    Then check resolves every specifier, matching the scratch copy's own file layout
    And nothing is frozen yet, and every violation is a public-surface bypass or an uncovered file
    When an exclude for the scratch copy's own loose root files is added
    And archstrict check runs against the scratch copy again
    Then check reports exactly the loose-file count fewer violations, and every remaining one is a public-surface bypass
    When archstrict todo runs against the scratch copy
    And archstrict check runs against the scratch copy again
    Then check is green, with every violation now frozen
    When one more cross-module import is added to the scratch copy
    And archstrict check runs against the scratch copy again
    Then check reports exactly one new violation, and the frozen count is unchanged
