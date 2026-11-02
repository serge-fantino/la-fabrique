Feature: Report a defect from the app

  Scenario: A linked person reports a defect on the part of the page that is wrong
    Given I am signed in to the app on int and linked to La Fabrique
    When I press "Report a defect"
    And I pick the "Save" button and press "This one"
    And I write "Nothing happens" in "What I saw"
    And I press "Send"
    Then an issue is opened in my name with the page, the version and the component "Save"

  Scenario: Nothing in production
    Given I am signed in to the app in production
    Then I do not see "Report a defect"
