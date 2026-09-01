import { extendTheme } from "@chakra-ui/react";

const horizonTheme = extendTheme({
  config: { initialColorMode: "light", useSystemColorMode: false },
  colors: {
    brand: {
      50: "#E9E3FF",
      100: "#C0B8FE",
      200: "#A195FD",
      300: "#8171FC",
      400: "#7551FF",
      500: "#4318FF",
      600: "#3311DB",
      700: "#2111A5",
      800: "#190793",
      900: "#11047A",
    },
    secondary: {
      50: "#F8F9FF",
      100: "#E9E3FF",
      200: "#7551FF",
      300: "#7551FF",
      400: "#7551FF",
      500: "#7551FF",
    },
    navy: {
      50: "#E9EFFF",
      100: "#C0CCFF",
      200: "#A3B9FF",
      300: "#7B96FF",
      400: "#6B46FF",
      500: "#7551FF",
      600: "#4318FF",
      700: "#02044A",
      800: "#190793",
      900: "#11047A",
    },
  },
  fonts: {
    heading: `'DM Sans', sans-serif`,
    body: `'DM Sans', sans-serif`,
  },
  styles: {
    global: {
      body: {
        bg: "#F4F7FE",
        color: "#2B3674",
        fontFamily: "DM Sans",
      },
    },
  },
  components: {
    Card: {
      baseStyle: {
        container: {
          bg: "white",
          borderRadius: "20px",
          boxShadow: "0px 3.5px 5.5px rgba(0,0,0,0.02)",
          p: "20px",
        },
      },
    },
    Button: {
      baseStyle: {
        borderRadius: "16px",
        fontWeight: "700",
      },
      variants: {
        brand: {
          bg: "brand.500",
          color: "white",
          _hover: { bg: "brand.600" },
          _active: { bg: "brand.700" },
        },
        lightBrand: {
          bg: "white",
          color: "brand.500",
          border: "1px solid",
          borderColor: "brand.500",
          _hover: { bg: "brand.50" },
        },
      },
    },
    Badge: {
      baseStyle: {
        borderRadius: "8px",
        textTransform: "none",
      },
    },
  },
  breakpoints: {
    sm: "320px",
    md: "768px",
    lg: "960px",
    xl: "1200px",
    "2xl": "1600px",
  },
});

export default horizonTheme;
