// About you: the profile fields and the formulas that use them, checked against worked examples.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanProfile, PROFILE_DEFAULTS, restingEnergy, bodyFatFromBmi, navyBodyFat, intakeFloor, ageOf } from "../js/profile.js";

test("profile fields are checked and fall back to defaults", () => {
  assert.deepEqual(cleanProfile({}), PROFILE_DEFAULTS);
  assert.deepEqual(cleanProfile({ sex: "male", birthYear: "1998", heightIn: 70.04, bodyFat: 17.25, targetBodyFat: 10, targetPace: 0.75, targetDate: "2027-06-01", lengthUnit: "cm" }),
    { sex: "male", birthYear: 1998, heightIn: 70, bodyFat: 17.3, targetBodyFat: 10, targetPace: 0.75, targetDate: "2027-06-01", lengthUnit: "cm" });
  assert.deepEqual(cleanProfile({ sex: "robot", birthYear: 1800, heightIn: 300, targetPace: 3, targetDate: "soon", lengthUnit: "ft" }), PROFILE_DEFAULTS);
  assert.equal(ageOf({ birthYear: 1998 }, "2026-11-23"), 28);
});

test("resting energy: Mifflin–St Jeor and Katch–McArdle match worked examples", () => {
  const g = { sex: "male", birthYear: 1996, heightIn: 70 };
  // 80 kg, 177.8 cm, 30 y, male: 10·80 + 6.25·177.8 − 5·30 + 5 = 1766
  assert.equal(restingEnergy(g, 80 / 0.45359237, 0, "2026-06-01"), 1766);
  // female, same: 1766 − 166 = 1600
  assert.equal(restingEnergy({ ...g, sex: "female" }, 80 / 0.45359237, 0, "2026-06-01"), 1600);
  // Katch–McArdle: 80 kg at 15% → LBM 68 kg → 370 + 21.6·68 = 1839
  assert.equal(restingEnergy({}, 80 / 0.45359237, 15, "2026-06-01"), 1839);
  assert.equal(restingEnergy({}, 176, 0, "2026-06-01"), null, "not enough to go on");
  assert.equal(intakeFloor({ sex: "male" }, 1766), 1766);
  assert.equal(intakeFloor({ sex: "female" }, 1100), 1200);
});

test("body-fat formulas: Navy circumference and BMI-based (rough) estimates", () => {
  // Navy, male: waist 34, neck 15, height 70 → 86.01·log10(19) − 70.041·log10(70) + 36.76 = 17.51
  assert.equal(navyBodyFat("male", 70, { waist: 34, neck: 15 }), 17.5);
  // female: 163.205·log10(30 + 38 − 13) − 97.684·log10(65) − 78.387 = 28.56
  assert.equal(navyBodyFat("female", 65, { waist: 30, hips: 38, neck: 13 }), 28.6);
  assert.equal(navyBodyFat("male", 70, { waist: 14, neck: 15 }), null, "waist must exceed neck");
  assert.equal(navyBodyFat("", 70, { waist: 34, neck: 15 }), null, "sex needed");
  // Deurenberg: BMI 25.1 (175 lb, 70 in), 30 y, male → 1.2·25.1 + 6.9 − 10.8 − 5.4 ≈ 20.8
  assert.equal(bodyFatFromBmi({ sex: "male", birthYear: 1996, heightIn: 70 }, 175, "2026-06-01"), 20.8);
});
