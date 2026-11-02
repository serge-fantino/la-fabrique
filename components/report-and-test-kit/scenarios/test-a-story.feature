Feature: Test a story from the app

  Scenario: A tester ticks the criteria and validates a story
    Given I am signed in to the app on int, linked to La Fabrique with the right to test
    And a story waits to be tested on int with two acceptance criteria
    When I press "Test"
    And I tick both criteria
    And I press "Validate"
    Then the story is validated in my name in La Fabrique

  Scenario: Validate waits for every criterion
    Given I opened "Test" on a story with one criterion not ticked
    When I press "Validate"
    Then I am told that every criterion must be ticked first
