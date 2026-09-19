Feature: Dogfooding archstrict against nukadoko's real source

  nukadoko's src/ has no public-surface convention of its own (no module
  directory was built with archstrict in mind), so every module in it starts
  entirely private under archstrict's default posture. This checks that
  posture against real files instead of a synthetic fixture, and checks the
  full init -> check -> todo -> edit -> check round trip end to end.

  Scenario: every nukadoko module is private by default, and freezing it is green
    Given the nukadoko package's own published src exists as a scratch copy
    When archstrict init runs against the scratch copy
    And archstrict check runs against the scratch copy
    Then check resolves every specifier, matching the scratch copy's own file layout
    And nothing is frozen yet, and every violation is a public-surface bypass
    When archstrict todo runs against the scratch copy
    And archstrict check runs against the scratch copy again
    Then check is green, with every violation now frozen
    When one more cross-module import is added to the scratch copy
    And archstrict check runs against the scratch copy again
    Then check reports exactly one new violation, and the frozen count is unchanged
