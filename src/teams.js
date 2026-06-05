const { normalizeText } = require("./utils");

const TEAM_ALIAS = {
  "Burgos CF": "BUR",
  "CD Parquesol": "PAR",
  "Mullier FCN": "MUL",
  "CD Palencia FF": "PAL",
  'Burgos CF "B"': "BURB",
  "Gimnastica Segoviana": "GSEG",
  "Real Valladolid CF": "RVA",
  "CD San Jose": "SJOS",
  "CD Vasconia": "VAS",
  "CD Salamanca FF": "SAL",
  "CD Sanse": "SAN",
  "Real Sociedad": "RSO",
};

const TEAM_ALIAS_NORMALIZED = Object.fromEntries(
  Object.entries(TEAM_ALIAS).map(([key, value]) => [normalizeText(key), value])
);

function teamLogo(teamName) {
  switch (normalizeText(teamName)) {
    case "Mullier FCN":
      return "https://i.imgur.com/4qg4UQM.png?v=1";
    case "CD Parquesol":
      return "https://i.imgur.com/e0wJO1f.png?v=1";
    case "Burgos CF":
      return "https://i.imgur.com/j3LBEda.png?v=1";
    case "Real Valladolid CF":
      return "https://i.imgur.com/qKhdrpQ.png?v=1";
    case "Burgos CF B":
      return "https://i.imgur.com/j3LBEda.png?v=1";
    case "CD Salamanca FF":
      return "https://i.imgur.com/Bqh440C.png?v=1";
    case "CD Sanse":
      return "https://i.imgur.com/EiurODB.png?v=1";
    case "Real Sociedad":
      return "https://i.imgur.com/qm9OFus.png?v=1";
    default:
      return "https://i.imgur.com/TbQFLRO.png?v=1";
  }
}

module.exports = {
  TEAM_ALIAS_NORMALIZED,
  teamLogo,
};
