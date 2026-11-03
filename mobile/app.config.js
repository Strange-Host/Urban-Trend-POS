const fs = require("fs");
const base = require("./app.json");

// google-services.json (Firebase) is needed for push. It is kept out of git;
// when the file is present it is wired in, otherwise the app still builds without push.
module.exports = () => {
  const expo = { ...base.expo, android: { ...base.expo.android } };
  if (fs.existsSync("./google-services.json")) {
    expo.android.googleServicesFile = "./google-services.json";
  }
  return { expo };
};
