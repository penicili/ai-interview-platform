# frozen_string_literal: true

FactoryBot.define do
  factory :vacancy do
    tenant_id { create(:organization).id }
    created_by { create(:user).id }
    sequence(:role_title) { |n| "Senior Engineer #{n}" }

    trait :with_skills do
      after(:create) do |vacancy, evaluator|
        create_list(:vacancy_skill, evaluator.skill_count, vacancy: vacancy)
      end
    end

    transient do
      skill_count { 2 }
    end
  end

  factory :vacancy_skill do
    vacancy
    sequence(:skill_label) { |n| "Required Skill #{n}" }
    expected_level { 3 }
  end

  factory :fit_gap_report do
    portfolio
    vacancy
    skill_comparisons { [] }
    culture_narrative { '' }
    overall_narrative { '' }
  end
end