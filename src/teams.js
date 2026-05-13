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
  "Martutene KE": "MAR",
  "Real Sociedad": "RSO",
};

const TEAM_ALIAS_NORMALIZED = Object.fromEntries(
  Object.entries(TEAM_ALIAS).map(([key, value]) => [normalizeText(key), value])
);

function teamLogo(teamName) {
  switch (normalizeText(teamName)) {
    case "CD Palencia FF":
      return "/static/palencia.jpg";
    case "Mullier FCN":
      return "/static/mullier.png";
    case "CD Parquesol":
      return "/static/parquesol.png";
    case "Burgos CF":
    case 'Burgos CF "B"':
      return "/static/burgoscf.png";
    case "Real Valladolid CF":
      return "/static/valladolid.png";
    case "CD San Jose":
      return "/static/sanjose.png";
    case "Gimnastica Segoviana":
      return "/static/segoviana.png";
    case "CD Vasconia":
      return "/static/vasconia.png";
    case "CD Salamanca FF":
      return "/static/salamanca.png";
    case "Martutene KE":
      return "/static/martutene.png";
    case "Real Sociedad":
      return "/static/realsociedad.png";
    default:
      return "https://i.imgur.com/zk3Tj9D.png?v=1";
  }
}

module.exports = {
  TEAM_ALIAS_NORMALIZED,
  teamLogo,
};
