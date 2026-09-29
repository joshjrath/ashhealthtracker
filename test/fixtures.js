// Provider responses shaped like the documented APIs (USDA FoodData Central,
// Open Food Facts, FatSecret), shared by the lookup and endpoint tests.
export const n = (number, id, value, unitName = "G") => ({ nutrientNumber: number, nutrientId: id, value, unitName });

export const USDA_EGG = {
  fdcId: 171287, description: "Egg, whole, raw, fresh", dataType: "SR Legacy",
  foodNutrients: [n("203", 1003, 12.6), n("204", 1004, 9.51), n("205", 1005, 0.72), n("268", 1062, 598, "kJ"), n("208", 1008, 143, "KCAL"), n("291", 1079, 0)],
  foodMeasures: [
    { disseminationText: "1 cup (4.86 large eggs)", gramWeight: 243, rank: 1 },
    { disseminationText: "1 extra large", gramWeight: 56, rank: 2 },
    { disseminationText: "1 large", gramWeight: 50, rank: 3 },
    { disseminationText: "1 medium", gramWeight: 44, rank: 4 },
  ],
};
export const USDA_CHOBANI = {
  fdcId: 2034567, description: "ZERO SUGAR VANILLA YOGURT", dataType: "Branded",
  brandOwner: "Chobani, LLC", brandName: "CHOBANI", servingSize: 150, servingSizeUnit: "g",
  householdServingFullText: "1 container", publishedDate: "2024-05-01",
  foodNutrients: [n("203", 1003, 7.33), n("204", 1004, 0), n("205", 1005, 3.33), n("208", 1008, 40, "KCAL"), n("291", 1079, 0)],
};
export const USDA_OTHER_YOGURT = {
  fdcId: 2099999, description: "VANILLA YOGURT", dataType: "Branded", brandOwner: "Other Dairy Inc.", brandName: "OTHER DAIRY",
  servingSize: 170, servingSizeUnit: "GRM", householdServingFullText: "1 cup",
  foodNutrients: [n("203", 1003, 5), n("204", 1004, 1.5), n("205", 1005, 12), n("208", 1008, 80, "KCAL")],
};
export const USDA_RICE = {
  fdcId: 169757, description: "Rice, white, long-grain, regular, enriched, cooked", dataType: "SR Legacy",
  foodNutrients: [n("203", 1003, 2.69), n("204", 1004, 0.28), n("205", 1005, 28.2), n("208", 1008, 130, "KCAL"), n("291", 1079, 0.4)],
  foodMeasures: [{ disseminationText: "1 cup", gramWeight: 158, rank: 1 }],
};
export const USDA_FOUNDATION_CHICKEN = {
  fdcId: 2646170, description: "Chicken, breast, boneless, skinless, raw", dataType: "Foundation",
  // Foundation foods may report energy only with Atwater factors.
  foodNutrients: [n("203", 1003, 22.5), n("204", 1004, 1.93), n("205", 1005, 0), n("958", 2048, 106, "KCAL")],
  foodMeasures: [],
};
export const OFF_CHOBANI = {
  code: "0818290014214", product_name: "Zero Sugar Vanilla", brands: "Chobani", serving_size: "150 g", serving_quantity: 150,
  nutriments: { "energy-kcal_100g": 40, "energy-kcal_serving": 60, proteins_100g: 7.3, proteins_serving: 11, carbohydrates_100g: 3.3, carbohydrates_serving: 5, fat_100g: 0, fat_serving: 0 },
};
export const FS_WAWA = {
  food_id: "123", food_name: "Turkey Shorti Hoagie", brand_name: "Wawa", food_type: "Brand",
  food_url: "https://foods.fatsecret.com/calories-nutrition/wawa/turkey-shorti-hoagie",
  food_description: "Per 1 sandwich - Calories: 520kcal | Fat: 20.00g | Carbs: 55.00g | Protein: 30.00g",
};
